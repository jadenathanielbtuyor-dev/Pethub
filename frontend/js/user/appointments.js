// PetHub User Appointments

// Module-level user variable
let currentUser = null;
let currentUserPets = [];
let appointmentPetsLoaded = false;
let appointmentPetsError = "";
let appointmentSubmitInProgress = false;
let appointmentDateAvailabilityRequestId = 0;
let appointmentDateAvailabilityController = null;
const NO_APPOINTMENT_PETS_MESSAGE = "Please add a pet first before booking an appointment.";
const INVALID_APPOINTMENT_DATE_MESSAGE = "Enter a valid appointment date.";
const INVALID_APPOINTMENT_TIME_MESSAGE = "Enter a valid appointment time.";
const PAST_APPOINTMENT_DATE_MESSAGE = "Appointment date cannot be in the past.";
const PAST_APPOINTMENT_TIME_MESSAGE = "Appointment time must be later than the current time when booking for today.";
const APPOINTMENT_DATE_AVAILABILITY_NOTE = "That slot is unavailable. Choose another time.";
const OCCUPIED_APPOINTMENT_STATUSES = new Set(["approved", "completed"]);
const APPOINTMENT_DATE_TIME_MESSAGES = [
  INVALID_APPOINTMENT_DATE_MESSAGE,
  INVALID_APPOINTMENT_TIME_MESSAGE,
  PAST_APPOINTMENT_DATE_MESSAGE,
  PAST_APPOINTMENT_TIME_MESSAGE,
];
const DEPOSIT_PAY_BUTTON_CLASS = "inline-flex items-center justify-center gap-2 rounded-lg border border-orange-200 bg-orange-50 px-4 py-2 text-sm font-semibold text-orange-700 transition-colors hover:bg-orange-100";
const DEPOSIT_CHECK_BUTTON_CLASS = "inline-flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50";
const DEPOSIT_NOTICE_CLASSES = {
  success: "border-green-200 bg-green-50 text-green-700",
  error: "border-red-200 bg-red-50 text-red-700",
  info: "border-blue-100 bg-blue-50 text-blue-700",
};
const DEPOSIT_APPOINTMENT_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
// Same orange as "Continue to Secure Payment" (deposit-pay-button in assets/css: white text keeps 5:1 contrast)
const DEPOSIT_SUMMARY_PRIMARY_BUTTON_CLASS = "deposit-pay-button w-full py-3 font-semibold rounded-lg transition-all duration-200";
const SECURE_PAYMENT_BUTTON_HTML = '<i class="ri-lock-line mr-2" aria-hidden="true"></i>Continue to Secure Payment — ₱100.00';
const PAYMENT_UNAVAILABLE_BUTTON_HTML = '<i class="ri-lock-line mr-2" aria-hidden="true"></i>Online payment unavailable';
const BOOKING_DETAILS_HINTS = {
  incomplete: "Choose a pet, service, date and time to continue.",
  invalid: "Fix the date or time above to continue.",
  unavailable: "That time is unavailable. Choose another time to continue.",
};
// Shown instead of "Pending" for a deposit appointment whose ₱100 deposit is not verified yet
const BOOKING_INCOMPLETE_LABEL = "Booking incomplete";
// Shown instead of "Pending" for a deposit appointment whose deposit is verified: only the clinic approves it
const PENDING_APPROVAL_LABEL = "Pending admin approval";
const DEPOSIT_BOOKING_UNAVAILABLE_MESSAGE = "Bookings need a ₱100 deposit, and online payment is not available right now. Please try again later or contact the clinic.";
const DEPOSIT_AVAILABILITY_UNKNOWN_MESSAGE = "We could not check whether online payment is available, so bookings cannot be submitted right now. Refresh the page to try again.";
const DEPOSIT_AVAILABILITY_CHECKING_MESSAGE = "Please wait while we check that online payment is available.";
const DEPOSIT_STATUS_BADGE_CLASSES = {
  success: "bg-green-100 text-green-700",
  error: "bg-red-100 text-red-700",
  info: "bg-blue-100 text-blue-700",
  neutral: "bg-gray-100 text-gray-700",
};
// The appointment whose PayMongo checkout this tab opened last, so Back or a refresh shows its payment state
// instead of inviting a second booking. Cleared once the deposit is settled or the customer starts a new booking.
const DEPOSIT_CHECKOUT_STORAGE_KEY = "pethub.depositCheckoutAppointmentId";
// Set from the appointment list response: { required, amount, currency, checkout_available } while deposits are on
let depositPolicy = null;
// Whether "Continue to Secure Payment" can be used, from that same response:
// checking (no answer yet) | ready (deposits on, checkout available) | unavailable (deposits switched off on the server,
// or on without a working checkout) | error (the list could not be loaded, so availability is unknown)
let depositPolicyState = "checking";
// Whether the availability check flagged the selected time as taken
let bookingSlotUnavailable = false;
// "Payment status" text in the booking summary while the booking and its checkout are being prepared
let bookingSummaryBusyStatus = "";

// Initialize on page load
document.addEventListener("DOMContentLoaded", initAppointments);

/**
 * Initialize appointments feature
 */
function initAppointments() {
  // Verify API is available
  if (typeof window.API_BASE_URL === 'undefined') {
    console.error('API_BASE_URL not found. Ensure core/api.js is loaded first.');
    return;
  }

  // Check authentication and populate currentUser using central helpers
  const user = getUser();
  if (!isLoggedIn() || !user) {
    redirectToLogin();
    return;
  }

  currentUser = user;

  // Load appointments and setup form
  setupAppointmentDateMin();
  setupServiceDurationHint();
  renderAppointmentPetOptions();
  updateAppointmentPetBookingState();
  loadAppointmentPets(currentUser.id);
  setupBookingSummary();
  setupDepositActions();
  setupDepositPageRestore();
  const depositReturn = readDepositCheckoutReturn() || readStoredDepositCheckout();
  if (depositReturn) {
    handleDepositCheckoutReturn(depositReturn);
  } else {
    loadAppointments(currentUser.id);
  }
  setupFormHandler();
}

function getTodayDateValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getTimeInputValue(date = new Date()) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function setupAppointmentDateMin() {
  const dateInput = document.getElementById("appointmentDate");
  const timeInput = document.getElementById("appointmentTime");
  if (!dateInput) return;

  applyAppointmentDateMin(dateInput);

  const updateDateValidity = () => {
    updateAppointmentDateTimeValidation({ showFeedback: true });
    updateAppointmentDateAvailabilityNote();
  };
  const updateTimeValidity = () => {
    updateAppointmentDateTimeValidation({ showFeedback: true });
    updateAppointmentDateAvailabilityNote();
  };

  dateInput.addEventListener("input", updateDateValidity);
  dateInput.addEventListener("change", updateDateValidity);
  dateInput.addEventListener("focus", () => updateAppointmentDateTimeValidation());
  if (timeInput) {
    timeInput.addEventListener("input", updateTimeValidity);
    timeInput.addEventListener("change", updateTimeValidity);
    timeInput.addEventListener("focus", () => updateAppointmentDateTimeValidation());
  }
  updateAppointmentDateTimeValidation();
  updateAppointmentDateAvailabilityNote();
}

function applyAppointmentDateMin(dateInput = document.getElementById("appointmentDate")) {
  if (!dateInput) return;

  const todayValue = getTodayDateValue();
  dateInput.min = todayValue;
}

function applyAppointmentTimeMin(
  dateInput = document.getElementById("appointmentDate"),
  timeInput = document.getElementById("appointmentTime")
) {
  if (!dateInput || !timeInput) return;

  if (dateInput.value === getTodayDateValue()) {
    timeInput.min = getTimeInputValue();
    return;
  }

  timeInput.removeAttribute("min");
}

function isValidAppointmentDateValue(dateValue) {
  const match = String(dateValue || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsedDate = new Date(year, month - 1, day);
  return (
    parsedDate.getFullYear() === year &&
    parsedDate.getMonth() === month - 1 &&
    parsedDate.getDate() === day
  );
}

function isValidAppointmentTimeValue(timeValue) {
  const match = String(timeValue || "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return false;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  return (
    Number.isInteger(hours) &&
    Number.isInteger(minutes) &&
    Number.isInteger(seconds) &&
    hours >= 0 &&
    hours <= 23 &&
    minutes >= 0 &&
    minutes <= 59 &&
    seconds >= 0 &&
    seconds <= 59
  );
}

function getAppointmentDateTimeValidation(dateValue, timeValue) {
  const normalizedDate = String(dateValue || "").trim();
  const normalizedTime = String(timeValue || "").trim();
  const todayValue = getTodayDateValue();

  if (normalizedDate && !isValidAppointmentDateValue(normalizedDate)) {
    return { dateError: INVALID_APPOINTMENT_DATE_MESSAGE, timeError: "", message: INVALID_APPOINTMENT_DATE_MESSAGE };
  }

  if (normalizedTime && !isValidAppointmentTimeValue(normalizedTime)) {
    return { dateError: "", timeError: INVALID_APPOINTMENT_TIME_MESSAGE, message: INVALID_APPOINTMENT_TIME_MESSAGE };
  }

  if (normalizedDate && normalizedDate < todayValue) {
    return { dateError: PAST_APPOINTMENT_DATE_MESSAGE, timeError: "", message: PAST_APPOINTMENT_DATE_MESSAGE };
  }

  if (normalizedDate === todayValue && normalizedTime && isPastAppointmentDateTime(normalizedDate, normalizedTime)) {
    return { dateError: "", timeError: PAST_APPOINTMENT_TIME_MESSAGE, message: PAST_APPOINTMENT_TIME_MESSAGE };
  }

  return { dateError: "", timeError: "", message: "" };
}

function setAppointmentFieldError(input, errorElement, message) {
  if (input) {
    input.setAttribute("aria-invalid", message ? "true" : "false");
    input.style.borderColor = message ? "#ef4444" : "";
  }

  if (!errorElement) return;
  errorElement.textContent = message || "";
  errorElement.classList.toggle("hidden", !message);
}

function isAppointmentDateTimeMessage(message) {
  return APPOINTMENT_DATE_TIME_MESSAGES.includes(String(message || "").trim());
}

function updateAppointmentDateTimeValidation(options = {}) {
  const dateInput = document.getElementById("appointmentDate");
  const timeInput = document.getElementById("appointmentTime");
  const messageContainer = document.getElementById("messageContainer");
  const dateError = document.getElementById("appointmentDateError");
  const timeError = document.getElementById("appointmentTimeError");
  if (!dateInput) return { dateError: "", timeError: "", message: "" };

  applyAppointmentDateMin(dateInput);
  applyAppointmentTimeMin(dateInput, timeInput);

  const validation = getAppointmentDateTimeValidation(dateInput.value, timeInput?.value);
  dateInput.setCustomValidity(validation.dateError || "");
  if (timeInput) timeInput.setCustomValidity(validation.timeError || "");
  setAppointmentFieldError(dateInput, dateError, validation.dateError);
  setAppointmentFieldError(timeInput, timeError, validation.timeError);

  if (messageContainer && validation.message && options.showFeedback) {
    showAppointmentFeedback(messageContainer, validation.message, "error");
  } else if (
    messageContainer &&
    !validation.message &&
    isAppointmentDateTimeMessage(messageContainer.textContent)
  ) {
    hideAppointmentFeedback(messageContainer);
  }

  return validation;
}

function clearAppointmentDateTimeErrors() {
  const dateInput = document.getElementById("appointmentDate");
  const timeInput = document.getElementById("appointmentTime");
  const dateError = document.getElementById("appointmentDateError");
  const timeError = document.getElementById("appointmentTimeError");

  if (dateInput) dateInput.setCustomValidity("");
  if (timeInput) timeInput.setCustomValidity("");
  setAppointmentFieldError(dateInput, dateError, "");
  setAppointmentFieldError(timeInput, timeError, "");
}

function applyServerAppointmentDateTimeError(message) {
  if (!isAppointmentDateTimeMessage(message)) return;

  const dateInput = document.getElementById("appointmentDate");
  const timeInput = document.getElementById("appointmentTime");
  const dateError = document.getElementById("appointmentDateError");
  const timeError = document.getElementById("appointmentTimeError");

  if (message === PAST_APPOINTMENT_DATE_MESSAGE || message === INVALID_APPOINTMENT_DATE_MESSAGE) {
    setAppointmentFieldError(dateInput, dateError, message);
    if (dateInput) dateInput.setCustomValidity(message);
    return;
  }

  setAppointmentFieldError(timeInput, timeError, message);
  if (timeInput) timeInput.setCustomValidity(message);
}

function isPastAppointmentDateTime(dateValue, timeValue) {
  const selectedDateTime = parseAppointmentDateTime(dateValue, timeValue);
  if (!selectedDateTime) return false;
  return selectedDateTime <= new Date();
}

function getAppointmentDateAvailabilityNoteElement() {
  const existingNote = document.getElementById("appointmentDateAvailabilityNote");
  if (existingNote) return existingNote;

  const dateError = document.getElementById("appointmentDateError");
  if (!dateError?.parentElement) return null;

  const note = document.createElement("p");
  note.id = "appointmentDateAvailabilityNote";
  note.className = "mt-2 hidden text-sm font-medium text-slate-500";
  note.setAttribute("aria-live", "polite");
  dateError.insertAdjacentElement("afterend", note);
  return note;
}

function setAppointmentDateAvailabilityNote(message) {
  bookingSlotUnavailable = Boolean(message);
  const note = getAppointmentDateAvailabilityNoteElement();
  if (note) {
    note.textContent = message || "";
    note.classList.toggle("hidden", !message);
  }
  updateAppointmentPetBookingState();
}

function getAppointmentRecordDateValue(dateValue) {
  const match = String(dateValue || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;

  const parsedDate = new Date(dateValue);
  if (Number.isNaN(parsedDate.getTime())) return "";
  return getTodayDateValue(parsedDate);
}

function getAppointmentTimeRange(dateValue, timeValue, durationMinutes) {
  const startTime = parseAppointmentDateTime(dateValue, timeValue);
  const duration = Number(durationMinutes);
  if (!startTime || !Number.isFinite(duration) || duration <= 0) return null;

  return {
    date: getAppointmentRecordDateValue(dateValue),
    startMs: startTime.getTime(),
    endMs: startTime.getTime() + duration * 60000,
  };
}

function appointmentRangesOverlap(first, second) {
  if (!first || !second || first.date !== second.date) return false;
  return first.startMs < second.endMs && second.startMs < first.endMs;
}

function getSelectedAppointmentTimeRange() {
  const serviceType = document.getElementById("serviceType")?.value.trim() || "";
  const dateValue = document.getElementById("appointmentDate")?.value.trim() || "";
  const timeValue = document.getElementById("appointmentTime")?.value.trim() || "";
  return getAppointmentTimeRange(dateValue, timeValue, getAppointmentDurationMinutes(serviceType));
}

function getStoredAppointmentTimeRange(appointment) {
  return getAppointmentTimeRange(
    getAppointmentRecordDateValue(appointment?.appointment_date),
    appointment?.appointment_time,
    getStoredAppointmentDurationMinutes(appointment)
  );
}

function isOccupiedAppointment(appointment) {
  const status = String(appointment?.status || "").trim().toLowerCase();
  return OCCUPIED_APPOINTMENT_STATUSES.has(status);
}

function appointmentConflictsWithSelectedSlot(appointment, selectedRange) {
  return isOccupiedAppointment(appointment) &&
    appointmentRangesOverlap(getStoredAppointmentTimeRange(appointment), selectedRange);
}

async function fetchAppointmentsForSelectedDate(dateValue, signal) {
  const endpoint = `${window.API_BASE_URL}/appointments/all?appointment_date=${encodeURIComponent(dateValue)}`;
  const response = await fetch(endpoint, { signal });
  if (!response.ok) return [];

  const data = await response.json().catch(() => ({}));
  return Array.isArray(data.appointments) ? data.appointments : [];
}

async function updateAppointmentDateAvailabilityNote() {
  const dateValue = String(document.getElementById("appointmentDate")?.value || "").trim();
  const selectedRange = getSelectedAppointmentTimeRange();
  const requestId = appointmentDateAvailabilityRequestId + 1;
  appointmentDateAvailabilityRequestId = requestId;

  if (appointmentDateAvailabilityController) {
    appointmentDateAvailabilityController.abort();
  }

  if (!dateValue || !isValidAppointmentDateValue(dateValue) || dateValue < getTodayDateValue() || !selectedRange) {
    setAppointmentDateAvailabilityNote("");
    return;
  }

  appointmentDateAvailabilityController = typeof AbortController !== "undefined"
    ? new AbortController()
    : null;

  try {
    const appointments = await fetchAppointmentsForSelectedDate(
      dateValue,
      appointmentDateAvailabilityController?.signal
    );
    if (requestId !== appointmentDateAvailabilityRequestId) return;

    const hasUnavailableSlot = appointments.some(appointment =>
      appointmentConflictsWithSelectedSlot(appointment, selectedRange)
    );
    setAppointmentDateAvailabilityNote(hasUnavailableSlot ? APPOINTMENT_DATE_AVAILABILITY_NOTE : "");
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.warn("Unable to load appointment date availability:", error);
    }
    if (requestId === appointmentDateAvailabilityRequestId) {
      setAppointmentDateAvailabilityNote("");
    }
  }
}

function showAppointmentDateTimeError(container, message) {
  const feedback = message || PAST_APPOINTMENT_TIME_MESSAGE;
  if (container) {
    showAppointmentFeedback(container, feedback, "error");
  } else if (typeof showError === "function") {
    showError(feedback);
  }
}

function getAppointmentDurationLabel(serviceType) {
  if (!window.AppointmentDurations) return "Duration unavailable";
  return window.AppointmentDurations.formatDuration(serviceType);
}

function getStoredAppointmentDurationMinutes(appointment) {
  const duration = Number(appointment?.estimated_duration_minutes);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function formatAppointmentDurationMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "N/A";
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minutes`;
}

function getAppointmentDisplayDuration(appointment) {
  return formatAppointmentDurationMinutes(getStoredAppointmentDurationMinutes(appointment));
}

function getAppointmentDurationMinutes(serviceType) {
  if (!window.AppointmentDurations) return null;
  return window.AppointmentDurations.getDurationMinutes(serviceType);
}

function isKnownAppointmentServiceType(serviceType) {
  if (!window.AppointmentDurations) return true;
  return window.AppointmentDurations.hasService(serviceType);
}

function parseAppointmentDateTime(dateValue, timeValue) {
  const dateMatch = String(dateValue || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = String(timeValue || "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!dateMatch || !timeMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const seconds = Number(timeMatch[3] || 0);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    !Number.isInteger(seconds) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59 ||
    seconds < 0 ||
    seconds > 59
  ) {
    return null;
  }

  const appointmentDate = new Date(year, month - 1, day, hours, minutes, seconds, 0);
  if (
    appointmentDate.getFullYear() !== year ||
    appointmentDate.getMonth() !== month - 1 ||
    appointmentDate.getDate() !== day
  ) {
    return null;
  }

  return appointmentDate;
}

function getEstimatedAppointmentEndTime(serviceType, dateValue, timeValue) {
  const durationMinutes = getAppointmentDurationMinutes(serviceType);
  const startTime = parseAppointmentDateTime(dateValue, timeValue);
  if (!Number.isFinite(durationMinutes) || !startTime) return "";

  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);
  return endTime.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatAppointmentDateDisplay(dateValue) {
  const match = String(dateValue || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "N/A";

  const appointmentDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(appointmentDate.getTime())) return "N/A";
  return appointmentDate.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function getAppointmentTimeRangeDisplay(appointment) {
  const durationMinutes = getStoredAppointmentDurationMinutes(appointment);
  const startTime = parseAppointmentDateTime(appointment?.appointment_date, appointment?.appointment_time);
  if (!Number.isFinite(durationMinutes) || !startTime) return "N/A";

  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);
  const formatOptions = { hour: "numeric", minute: "2-digit" };
  return `${startTime.toLocaleTimeString("en-US", formatOptions)} - ${endTime.toLocaleTimeString("en-US", formatOptions)}`;
}

function formatSuggestedAppointmentTimeDisplay(timeValue) {
  const match = String(timeValue || "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return "";

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59 ||
    seconds < 0 ||
    seconds > 59
  ) {
    return "";
  }

  return new Date(2000, 0, 1, hours, minutes, seconds).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function getAppointmentBookingErrorMessage(error) {
  const suggestedTime = formatSuggestedAppointmentTimeDisplay(error?.suggestedTime);
  if (suggestedTime) {
    return `That slot is unavailable. Next available time: ${suggestedTime}.`;
  }

  return error?.message || "Could not book appointment.";
}

function setupServiceDurationHint() {
  const serviceInput = document.getElementById("serviceType");
  const dateInput = document.getElementById("appointmentDate");
  const timeInput = document.getElementById("appointmentTime");
  const hint = document.getElementById("serviceDurationHint");
  if (!serviceInput || !hint) return;

  const updateHint = () => {
    const serviceType = serviceInput.value;
    if (!serviceType) {
      hint.textContent = "";
      hint.classList.add("hidden");
      return;
    }

    const estimatedEndTime = getEstimatedAppointmentEndTime(serviceType, dateInput?.value, timeInput?.value);
    hint.textContent = estimatedEndTime
      ? `Estimated end time: ${estimatedEndTime}`
      : `Estimated duration: ${getAppointmentDurationLabel(serviceType)}`;
    hint.classList.remove("hidden");
  };

  serviceInput.addEventListener("change", updateHint);
  serviceInput.addEventListener("change", updateAppointmentDateAvailabilityNote);
  if (dateInput) dateInput.addEventListener("change", updateHint);
  if (timeInput) timeInput.addEventListener("change", updateHint);
  if (timeInput) timeInput.addEventListener("input", updateHint);
  updateHint();
}

function clearServiceDurationHint() {
  const hint = document.getElementById("serviceDurationHint");
  if (!hint) return;

  hint.textContent = "";
  hint.classList.add("hidden");
}

function getAppointmentPetSelect() {
  return document.getElementById("petSelect");
}

function getAppointmentPetHint() {
  return document.getElementById("petSelectHint");
}

function getAppointmentSubmitButton() {
  return document.querySelector("#appointmentForm button[type=\"submit\"]");
}

function getAppointmentPetOptionLabel(pet) {
  const name = String(pet?.name || "").trim();
  const species = String(pet?.species || "").trim();
  return species ? `${name} - ${species}` : name;
}

function getAppointmentPetById(petId) {
  const normalizedPetId = String(petId || "").trim();
  if (!normalizedPetId) return null;
  return currentUserPets.find(pet => String(pet.id) === normalizedPetId) || null;
}

function renderAppointmentPetOptions() {
  const petSelect = getAppointmentPetSelect();
  if (!petSelect) return;

  const previousValue = petSelect.value;
  petSelect.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = appointmentPetsError
    ? "Unable to load pets"
    : !appointmentPetsLoaded
      ? "Loading pets..."
      : currentUserPets.length > 0
        ? "Select Pet"
        : "No registered pets";
  petSelect.appendChild(defaultOption);

  currentUserPets.forEach(pet => {
    if (!pet?.id || !pet?.name) return;
    const option = document.createElement("option");
    option.value = String(pet.id);
    option.textContent = getAppointmentPetOptionLabel(pet);
    petSelect.appendChild(option);
  });

  if (previousValue && getAppointmentPetById(previousValue)) {
    petSelect.value = previousValue;
  }
}

function updateAppointmentPetBookingState() {
  const petSelect = getAppointmentPetSelect();
  const hint = getAppointmentPetHint();
  const submitButton = getAppointmentSubmitButton();
  const form = document.getElementById("appointmentForm");
  const hasPets = currentUserPets.length > 0;
  const shouldDisableBooking = Boolean(appointmentPetsError) || !appointmentPetsLoaded || !hasPets;
  // "Continue to Secure Payment" stays disabled until the booking details are complete and valid, and while the
  // deposit cannot be paid online (or that has not been confirmed yet)
  const bookingDraft = getBookingDraft();
  const shouldDisableSubmit = shouldDisableBooking || !bookingDraft.valid || !isDepositCheckoutAvailable();

  if (petSelect) {
    petSelect.disabled = shouldDisableBooking;
  }

  if (submitButton && !appointmentSubmitInProgress && !isFormSubmitting(form)) {
    submitButton.disabled = shouldDisableSubmit;
    submitButton.classList.toggle("opacity-60", shouldDisableSubmit);
    submitButton.classList.toggle("cursor-not-allowed", shouldDisableSubmit);
  }

  renderBookingSummary(bookingDraft, { showHint: !shouldDisableBooking });

  if (!hint) return;

  hint.classList.remove("hidden", "text-red-600", "text-slate-500");
  if (appointmentPetsError) {
    hint.textContent = appointmentPetsError;
    hint.classList.add("text-red-600");
  } else if (!appointmentPetsLoaded) {
    hint.textContent = "Loading your pets...";
    hint.classList.add("text-slate-500");
  } else if (!hasPets) {
    hint.textContent = NO_APPOINTMENT_PETS_MESSAGE;
    hint.classList.add("text-slate-500");
  } else {
    hint.textContent = "";
    hint.classList.add("hidden", "text-slate-500");
  }
}

async function loadAppointmentPets(userId) {
  const petSelect = getAppointmentPetSelect();
  if (!petSelect || !userId) return [];

  currentUserPets = [];
  appointmentPetsLoaded = false;
  appointmentPetsError = "";
  renderAppointmentPetOptions();
  updateAppointmentPetBookingState();

  try {
    const response = await fetch(`${window.API_BASE_URL}/pets/userPets?user_id=${encodeURIComponent(userId)}`);
    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.success === false) {
      throw new Error(data.error || `Failed to load pets (${response.status})`);
    }

    currentUserPets = Array.isArray(data.pets)
      ? data.pets.filter(pet => pet && pet.id && pet.name)
      : [];
    appointmentPetsLoaded = true;
    appointmentPetsError = "";
    renderAppointmentPetOptions();
    updateAppointmentPetBookingState();
    return currentUserPets;
  } catch (error) {
    console.error("Error loading appointment pets:", error);
    currentUserPets = [];
    appointmentPetsLoaded = true;
    appointmentPetsError = error.message || "Unable to load your pets right now.";
    renderAppointmentPetOptions();
    updateAppointmentPetBookingState();
    return [];
  }
}

/**
 * Load user appointments from backend. Returns the loaded list ([] when it could not be loaded).
 */
async function loadAppointments(userId) {
  const container = document.getElementById("appointmentsList");
  if (container) {
    container.innerHTML = getUserAppointmentsLoadingHtml();
  }

  try {
    const response = await fetch(`${window.API_BASE_URL}/appointments/userAppointments?user_id=${userId}`);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(errorData.error || `Failed to load appointments (${response.status})`);
    }
    
    const data = await response.json();
    const appointments = Array.isArray(data.appointments) ? data.appointments : [];
    updateDepositPolicy(data.deposit_policy);
    displayAppointments(appointments);
    return appointments;
  } catch (error) {
    console.error("Error loading appointments:", error);
    if (container) {
      container.innerHTML = getUserAppointmentsErrorHtml(error.message);
    }
    markDepositPolicyUnknown();
    return [];
  }
}

function getUserAppointmentsLoadingHtml() {
  return `
    <div class="dashboard-loading-state" role="status" aria-live="polite">
      <div class="dashboard-loading-spinner" aria-hidden="true"></div>
      <div>
        <p class="dashboard-loading-title">Loading appointments...</p>
        <p class="dashboard-loading-copy">Fetching the latest PetHub records.</p>
      </div>
    </div>
  `;
}

function getUserAppointmentsErrorHtml(message) {
  return `
    <div class="rounded-lg border border-red-200 bg-red-50 p-5 text-center text-red-700">
      <p class="font-semibold">Unable to load appointments</p>
      <p class="mt-1 text-sm">${escapeHtml(message || "Please refresh the page or try again later.")}</p>
    </div>
  `;
}

/**
 * Display appointments list
 */
function displayAppointments(appointments) {
  const container = document.getElementById("appointmentsList");
  if (!container) return;

  if (!appointments || appointments.length === 0) {
    container.innerHTML = `
      <div class="rounded-lg border border-gray-200 bg-white p-5 text-center text-gray-500">
        <div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-100 text-blue-500">
          <i class="ri-calendar-event-line text-2xl" aria-hidden="true"></i>
        </div>
        <p class="font-medium text-gray-700">No appointments yet</p>
        <p class="mt-1 text-sm">Appointments you book will appear here with their clinic status.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = appointments
    .map((apt) => {
      const handledBy = getHandledByLabel(apt);
      // A deposit appointment is only booked once its deposit is verified; until then it is an incomplete booking
      const status = getCustomerAppointmentStatus(apt);
      const handledByRow = handledBy
        ? `
          <div>
            <dt class="text-xs font-semibold uppercase tracking-wide text-gray-400">Handled by</dt>
            <dd class="mt-1 text-sm font-medium text-gray-700">${escapeHtml(handledBy)}</dd>
          </div>
        `
        : "";
      const cardId = getDepositAppointmentId(apt);
      return `
        <div ${cardId ? `id="appointment-${cardId}" ` : ""}class="rounded-lg border border-gray-100 bg-white p-5 shadow-sm">
          <dl class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt class="text-xs font-semibold uppercase tracking-wide text-gray-400">Reference</dt>
              <dd class="mt-1 text-sm font-semibold text-gray-700">${escapeHtml(getAppointmentReference(apt))}</dd>
            </div>
            <div>
              <dt class="text-xs font-semibold uppercase tracking-wide text-gray-400">Pet</dt>
              <dd class="mt-1 text-sm font-semibold text-gray-900">${escapeHtml(apt.pet_name || 'N/A')}</dd>
            </div>
            <div>
              <dt class="text-xs font-semibold uppercase tracking-wide text-gray-400">Service</dt>
              <dd class="mt-1 text-sm font-medium text-gray-700">${escapeHtml(apt.service_type || 'N/A')}</dd>
            </div>
            <div>
              <dt class="text-xs font-semibold uppercase tracking-wide text-gray-400">Duration</dt>
              <dd class="mt-1 text-sm font-medium text-gray-700">${escapeHtml(getAppointmentDisplayDuration(apt))}</dd>
            </div>
            <div>
              <dt class="text-xs font-semibold uppercase tracking-wide text-gray-400">Date</dt>
              <dd class="mt-1 text-sm font-medium text-gray-700">${escapeHtml(formatAppointmentDateDisplay(apt.appointment_date))}</dd>
            </div>
            <div>
              <dt class="text-xs font-semibold uppercase tracking-wide text-gray-400">Time range</dt>
              <dd class="mt-1 text-sm font-medium text-gray-700">${escapeHtml(getAppointmentTimeRangeDisplay(apt))}</dd>
            </div>
            <div>
              <dt class="text-xs font-semibold uppercase tracking-wide text-gray-400">${hasDepositInfo(apt) ? "Appointment status" : "Status"}</dt>
              <dd class="mt-1">
                <span class="inline-flex rounded-full px-3 py-1 text-xs font-semibold ${getStatusClass(status)}">
                  ${escapeHtml(status)}
                </span>
              </dd>
            </div>
            ${handledByRow}
            ${getDepositDetailsHtml(apt)}
          </dl>
          ${getDepositActionsHtml(apt)}
        </div>
      `;
    })
    .join("");
  revealLinkedAppointment();
}

// The dashboard links an unfinished booking as appointments.html#appointment-<id>. The list is drawn after it loads,
// so the browser cannot scroll there by itself; this does it once.
let linkedAppointmentRevealed = false;
function revealLinkedAppointment() {
  if (linkedAppointmentRevealed) return;
  const match = window.location.hash.match(/^#appointment-([A-Za-z0-9-]{1,64})$/);
  const card = match ? document.getElementById(`appointment-${match[1]}`) : null;
  if (!card) return;
  linkedAppointmentRevealed = true;
  card.scrollIntoView({ block: "center" });
}

function getHandledByLabel(appointment) {
  if (!appointment || !appointment.handled_by || !appointment.handled_by_name) return "";
  return appointment.handled_by_name;
}

function getAppointmentStatusLabel(status) {
  if (status === undefined || status === null || String(status).trim() === "") {
    return "Status not recorded";
  }

  const normalizedStatus = String(status).trim().toLowerCase();
  const statusMap = {
    pending: "Pending",
    approved: "Approved",
    completed: "Completed",
    cancelled: "Cancelled",
  };

  return statusMap[normalizedStatus] || String(status).trim();
}

/**
 * Get CSS class for status badge
 */
function getStatusClass(status) {
  const statusClasses = {
    Approved: "bg-blue-100 text-blue-700",
    Cancelled: "bg-red-100 text-red-700",
    Completed: "bg-green-100 text-green-700",
    Pending: "bg-yellow-100 text-yellow-700",
    [PENDING_APPROVAL_LABEL]: "bg-yellow-100 text-yellow-700",
    [BOOKING_INCOMPLETE_LABEL]: "bg-orange-100 text-orange-700",
  };
  return statusClasses[status] || "bg-gray-100 text-gray-700";
}

// ==================== APPOINTMENT DEPOSITS ====================
// The backend decides the ₱100 deposit (amount, eligibility and status). This page only shows that state and opens
// the PayMongo checkout URL the backend returns. Coming back from PayMongo only tells the page which appointment
// to re-check with the backend; the redirect itself never counts as payment.

function hasDepositInfo(appointment) {
  return Boolean(appointment && appointment.deposit && appointment.deposit.required !== false);
}

// A Pending appointment that needs the deposit but has no verified payment (unpaid, checkout open, refunded,
// or its status could not be checked) is not booked yet
function isIncompleteDepositBooking(appointment) {
  return hasDepositInfo(appointment) &&
    getAppointmentStatusLabel(appointment.status) === "Pending" &&
    appointment.deposit.status !== "paid";
}

// The appointment status the customer sees, kept apart from the payment status. Appointments without a deposit
// keep their usual labels.
function getCustomerAppointmentStatus(appointment) {
  const status = getAppointmentStatusLabel(appointment?.status);
  if (!hasDepositInfo(appointment)) return status;
  if (isIncompleteDepositBooking(appointment)) return BOOKING_INCOMPLETE_LABEL;
  return status === "Pending" ? PENDING_APPROVAL_LABEL : status;
}

// A short reference to quote to the clinic: the stored appointment_reference is empty, so it is derived from the id
function getAppointmentReference(appointment) {
  const compactId = String(appointment?.id || "").replace(/[^A-Za-z0-9]/g, "");
  return compactId ? `PH-${compactId.slice(0, 8).toUpperCase()}` : "N/A";
}

function formatDepositPeso(source) {
  const amount = Number(source?.amount);
  return `₱${(Number.isFinite(amount) && amount > 0 ? amount : 100).toFixed(2)}`;
}

function getDepositAppointmentId(appointment) {
  const appointmentId = String(appointment?.id || "");
  return DEPOSIT_APPOINTMENT_ID_PATTERN.test(appointmentId) ? appointmentId : "";
}

function formatDepositTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function formatDepositDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// The payment status the customer sees (verified by the backend; never from the checkout redirect)
function getDepositDisplay(appointment) {
  const deposit = appointment.deposit;
  const isPendingAppointment = getAppointmentStatusLabel(appointment.status) === "Pending";
  if (deposit.status === "paid") {
    if (deposit.refund_required) {
      return { label: "Refund due", className: "bg-red-100 text-red-700", note: "The clinic will refund your ₱100 deposit." };
    }
    const paidAt = formatDepositDateTime(deposit.paid_at);
    const next = isPendingAppointment ? " Your appointment is pending admin approval." : "";
    return {
      label: "Paid",
      className: "bg-green-100 text-green-700",
      note: `${paidAt ? `Deposit paid ${paidAt}.` : "Deposit paid."}${next}`,
    };
  }
  if (deposit.status === "refunded") {
    return { label: "Refunded", className: "bg-gray-100 text-gray-700", note: "" };
  }
  if (deposit.status === "unavailable") {
    return { label: "Status unavailable", className: "bg-gray-100 text-gray-700", note: "We could not check the deposit just now. Check again in a moment." };
  }
  if (!isPendingAppointment) {
    return { label: "Not paid", className: "bg-gray-100 text-gray-700", note: "" };
  }
  if (deposit.status === "pending") {
    const openUntil = formatDepositTime(deposit.checkout_expires_at);
    return {
      label: "Payment pending",
      className: "bg-blue-100 text-blue-700",
      note: `${openUntil ? `Your checkout is open until ${openUntil}. ` : ""}The booking is complete once the payment is verified.`,
    };
  }

  const lastCheckout = {
    expired: { label: "Checkout expired", note: "Your last checkout expired before payment. Pay the ₱100 deposit to complete this booking." },
    failed: { label: "Payment failed", note: "Your last checkout could not be completed. Pay the ₱100 deposit to complete this booking." },
  }[deposit.last_checkout_status];
  return {
    label: lastCheckout ? lastCheckout.label : "Awaiting payment",
    className: lastCheckout ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-700",
    note: lastCheckout ? lastCheckout.note : "This booking is not complete until the ₱100 deposit is paid. The clinic reviews it after payment.",
  };
}

function getDepositDetailsHtml(appointment) {
  if (!hasDepositInfo(appointment)) return "";
  const display = getDepositDisplay(appointment);
  return `
    <div>
      <dt class="text-xs font-semibold uppercase tracking-wide text-gray-400">Payment status</dt>
      <dd class="mt-1">
        <span class="inline-flex rounded-full px-3 py-1 text-xs font-semibold ${display.className}">
          ${escapeHtml(display.label)}
        </span>
      </dd>
    </div>
    <div>
      <dt class="text-xs font-semibold uppercase tracking-wide text-gray-400">Deposit</dt>
      <dd class="mt-1 text-sm font-medium text-gray-700">${escapeHtml(formatDepositPeso(appointment.deposit))}</dd>
    </div>
  `;
}

function getDepositActionsHtml(appointment) {
  if (!hasDepositInfo(appointment)) return "";

  const deposit = appointment.deposit;
  const appointmentId = getDepositAppointmentId(appointment);
  const isPendingAppointment = getAppointmentStatusLabel(appointment.status) === "Pending";
  const buttons = [];

  if (deposit.can_pay && appointmentId) {
    const label = deposit.status === "pending" ? "Continue ₱100 deposit payment" : "Pay ₱100 deposit";
    buttons.push(`
      <button type="button" class="${DEPOSIT_PAY_BUTTON_CLASS}" data-deposit-action="pay" data-appointment-id="${appointmentId}">
        <i class="ri-bank-card-line" aria-hidden="true"></i><span>${escapeHtml(label)}</span>
      </button>
    `);
  }
  if (["pending", "unavailable"].includes(deposit.status) && isPendingAppointment && appointmentId) {
    buttons.push(`
      <button type="button" class="${DEPOSIT_CHECK_BUTTON_CLASS}" data-deposit-action="check" data-appointment-id="${appointmentId}">
        <i class="ri-refresh-line" aria-hidden="true"></i><span>Check payment status</span>
      </button>
    `);
  }

  let note = getDepositDisplay(appointment).note;
  if (!deposit.can_pay && isPendingAppointment && ["unpaid", "pending", "refunded"].includes(deposit.status)) {
    note = "Online payment is not available for this appointment right now. Please contact the clinic.";
  }
  if (buttons.length === 0 && !note) return "";

  return `
    <div class="mt-4 flex flex-wrap items-center gap-3">
      ${buttons.join("")}
      ${note ? `<p class="text-sm text-gray-600">${escapeHtml(note)}</p>` : ""}
    </div>
  `;
}

function getDepositNoticeElement() {
  let notice = document.getElementById("depositNotice");
  if (notice) return notice;

  const list = document.getElementById("appointmentsList");
  if (!list || !list.parentNode) return null;

  notice = document.createElement("div");
  notice.id = "depositNotice";
  notice.className = "mb-4 hidden rounded-lg border p-3 text-sm";
  list.parentNode.insertBefore(notice, list);
  return notice;
}

function showDepositNotice(message, type = "info") {
  const notice = getDepositNoticeElement();
  if (!notice) return;
  notice.className = `mb-4 rounded-lg border p-3 text-sm ${DEPOSIT_NOTICE_CLASSES[type] || DEPOSIT_NOTICE_CLASSES.info}`;
  notice.setAttribute("role", type === "error" ? "alert" : "status");
  notice.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
  notice.textContent = message;
}

function isPayMongoCheckoutUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && (url.hostname === "paymongo.com" || url.hostname.endsWith(".paymongo.com"));
  } catch (error) {
    return false;
  }
}

async function fetchDepositStatus(appointmentId) {
  const response = await fetch(`${window.API_BASE_URL}/payments/appointment/${encodeURIComponent(appointmentId)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.deposit) {
    throw new Error(data.error || "We could not check the deposit right now. Please try again in a moment.");
  }
  return data.deposit;
}

function getDepositStatusMessage(deposit, outcome = "") {
  if (deposit.status === "paid" && deposit.refund_required) {
    return "Your ₱100 deposit was received, but this appointment can no longer go ahead. The clinic will refund the deposit.";
  }
  if (deposit.status === "paid") {
    return "Your ₱100 deposit was received. The clinic will now review your appointment.";
  }
  if (deposit.status === "not_required") {
    return "This appointment does not need a deposit.";
  }
  if (deposit.status === "pending" && outcome === "cancelled") {
    return "You left the payment page before paying. You can continue the deposit payment from your appointments list.";
  }
  if (deposit.status === "pending") {
    return "We have not received confirmation of your payment yet. This can take a minute; use \"Check payment status\" to look again.";
  }
  return "The deposit has not been paid. You can try again from your appointments list.";
}

// Asks the backend for the appointment's PayMongo checkout (a new one, or the open one it resumes) and returns its URL.
// Only the appointment id is sent: the backend decides the amount and whether a deposit can be paid.
async function requestDepositCheckout(appointmentId) {
  const response = await fetch(`${window.API_BASE_URL}/payments/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appointment_id: appointmentId }),
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || !isPayMongoCheckoutUrl(data.checkout_url)) {
    throw new Error(data.error || "We could not open the payment page. Please try again.");
  }
  return data.checkout_url;
}

async function startDepositCheckout(button, appointmentId) {
  if (!appointmentId || button?.dataset?.loading === "true") return;

  updateButtonState(button, true, "Preparing secure checkout...");
  try {
    const checkoutUrl = await requestDepositCheckout(appointmentId);
    rememberDepositCheckout(appointmentId);
    updateButtonState(button, true, "Redirecting to PayMongo...");
    // PayMongo's hosted checkout handles the payment; PetHub never sees card or e-wallet details
    window.location.assign(checkoutUrl);
  } catch (error) {
    console.error("Deposit checkout error:", error);
    updateButtonState(button, false);
    showDepositNotice(error.message || "We could not open the payment page. Please try again.", "error");
    await loadAppointments(currentUser.id);
  }
}

async function refreshDepositStatus(button, appointmentId) {
  if (!appointmentId || button?.dataset?.loading === "true") return;

  updateButtonState(button, true, "Checking...");
  try {
    const deposit = await fetchDepositStatus(appointmentId);
    showDepositNotice(getDepositStatusMessage(deposit), deposit.status === "paid" ? "success" : "info");
  } catch (error) {
    showDepositNotice(error.message, "error");
  }
  await loadAppointments(currentUser.id);
}

function setupDepositActions() {
  const container = document.getElementById("appointmentsList");
  if (!container || container.dataset.depositActionsReady === "true") return;
  container.dataset.depositActionsReady = "true";

  container.addEventListener("click", (event) => {
    const button = event.target.closest("[data-deposit-action]");
    if (!button || !container.contains(button)) return;

    const appointmentId = String(button.dataset.appointmentId || "");
    if (!DEPOSIT_APPOINTMENT_ID_PATTERN.test(appointmentId)) return;

    if (button.dataset.depositAction === "pay") startDepositCheckout(button, appointmentId);
    if (button.dataset.depositAction === "check") refreshDepositStatus(button, appointmentId);
  });
}

// Reads ?payment=...&appointment_id=... once and removes it from the address bar, so a refresh does not repeat the check
function readDepositCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get("payment");
  const appointmentId = params.get("appointment_id");
  if (!outcome || !appointmentId) return null;

  params.delete("payment");
  params.delete("appointment_id");
  const query = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);

  return DEPOSIT_APPOINTMENT_ID_PATTERN.test(appointmentId) ? { outcome, appointmentId } : null;
}

// Back from PayMongo (outcome "return" or "cancelled"), or a later visit in the same tab ("left"): the booking card
// shows that appointment's deposit as the backend reports it
async function handleDepositCheckoutReturn({ outcome, appointmentId }) {
  showDepositResult(null, null, { checking: true });
  await refreshDepositResult(appointmentId, { outcome });
}

function readStoredDepositCheckout() {
  let appointmentId = "";
  try {
    appointmentId = sessionStorage.getItem(DEPOSIT_CHECKOUT_STORAGE_KEY) || "";
  } catch (error) {
    appointmentId = "";
  }
  return DEPOSIT_APPOINTMENT_ID_PATTERN.test(appointmentId) ? { outcome: "left", appointmentId } : null;
}

function rememberDepositCheckout(appointmentId) {
  try {
    sessionStorage.setItem(DEPOSIT_CHECKOUT_STORAGE_KEY, appointmentId);
  } catch (error) {
    // Without storage, Back from PayMongo still shows the deposit state in the appointments list
  }
}

function forgetDepositCheckout() {
  try {
    sessionStorage.removeItem(DEPOSIT_CHECKOUT_STORAGE_KEY);
  } catch (error) {
    // Nothing stored
  }
}

// Coming back with the browser's Back button from PayMongo can restore this page from memory, still showing
// "Redirecting to PayMongo...". Reset the booking controls, then show the deposit state of the checkout that was opened.
function setupDepositPageRestore() {
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted || !currentUser) return;
    appointmentSubmitInProgress = false;
    bookingSummaryBusyStatus = "";
    const form = document.getElementById("appointmentForm");
    setFormSubmitting(form, false, "Saving your booking...", "Continue to Secure Payment — ₱100.00");
    updateSubmitButtonLabel();
    updateAppointmentPetBookingState();

    const storedCheckout = readStoredDepositCheckout();
    if (storedCheckout) {
      handleDepositCheckoutReturn(storedCheckout);
      return;
    }
    hideDepositResult();
    loadAppointments(currentUser.id);
  });
}

// ==================== DEPOSIT BEFORE BOOKING ====================
// The booking form always shows the "Appointment Deposit" section (pages/user/appointments.html): the ₱100 deposit,
// the selected pet, service, date and time, the estimated duration and the deposit payment status, followed by
// "Continue to Secure Payment". That button books the appointment and opens its PayMongo checkout. It is only enabled
// once the appointment list response confirms that the deposit can be paid online (deposit_policy). Without that
// (deposits switched off on the server, checkout not configured, or the check failed) the section says so and the form
// books nothing: it never falls back to booking without the deposit. The appointment stays Pending, and the clinic can
// only approve it once the backend has verified the payment. After PayMongo, the booking card shows the deposit state.

function formatDepositAmount(policy) {
  const amount = Number(policy?.amount);
  const currency = String(policy?.currency || "PHP");
  const value = Number.isFinite(amount) && amount > 0 ? amount : 100;
  return `${currency === "PHP" ? "₱" : ""}${value.toFixed(2)} ${currency}`;
}

function isDepositCheckoutAvailable() {
  return depositPolicyState === "ready";
}

// From the appointment list response; the deposit section and the button follow every change
function updateDepositPolicy(policy) {
  depositPolicy = policy && policy.required === true ? policy : null;
  const nextState = depositPolicy && depositPolicy.checkout_available !== false ? "ready" : "unavailable";
  if (!depositPolicy && depositPolicyState !== nextState) {
    // Browser console only: tells a switched-off server apart from a broken page
    console.warn("PetHub: the appointment list has no deposit_policy, so online deposit payment is off on the backend (PAYMENTS_ENABLED is not \"true\" there). Booking stays disabled.");
  }
  depositPolicyState = nextState;
  updateSubmitButtonLabel();
  updateAppointmentPetBookingState();
}

// The appointment list could not be loaded. A policy seen earlier on this page still applies; without one,
// whether the deposit can be paid online is unknown, so booking stays disabled.
function markDepositPolicyUnknown() {
  if (depositPolicyState === "checking") depositPolicyState = "error";
  updateSubmitButtonLabel();
  updateAppointmentPetBookingState();
}

// The deposit payment status badge and the note under the summary, for the current state
function getDepositPanelState() {
  if (bookingSummaryBusyStatus) return { text: bookingSummaryBusyStatus, tone: "info", note: "" };
  return {
    checking: { text: "Checking payment availability...", tone: "info", note: "" },
    ready: { text: "Not paid yet", tone: "neutral", note: "" },
    unavailable: { text: "Online payment unavailable", tone: "neutral", note: DEPOSIT_BOOKING_UNAVAILABLE_MESSAGE },
    error: { text: "Status unavailable", tone: "neutral", note: DEPOSIT_AVAILABILITY_UNKNOWN_MESSAGE },
  }[depositPolicyState];
}

// "Continue to Secure Payment" (disabled until the details are valid), or "Online payment unavailable"
function updateSubmitButtonLabel() {
  const button = getAppointmentSubmitButton();
  if (!button || button.dataset.loading === "true") return;

  const html = ["unavailable", "error"].includes(depositPolicyState) ? PAYMENT_UNAVAILABLE_BUTTON_HTML : SECURE_PAYMENT_BUTTON_HTML;
  if (button.innerHTML !== html) button.innerHTML = html;
}

// The booking details as currently selected, and whether they are complete and valid enough to continue
function getBookingDraft() {
  const petId = getAppointmentPetSelect()?.value.trim() || "";
  const pet = getAppointmentPetById(petId);
  const serviceType = document.getElementById("serviceType")?.value.trim() || "";
  const appointmentDate = document.getElementById("appointmentDate")?.value.trim() || "";
  const appointmentTime = document.getElementById("appointmentTime")?.value.trim() || "";
  const complete = Boolean(pet && serviceType && isKnownAppointmentServiceType(serviceType) && appointmentDate && appointmentTime);

  let problem = "";
  if (!complete) problem = "incomplete";
  else if (getAppointmentDateTimeValidation(appointmentDate, appointmentTime).message) problem = "invalid";
  else if (bookingSlotUnavailable) problem = "unavailable";

  return {
    petId,
    petName: String(pet?.name || "").trim(),
    serviceType,
    appointmentDate,
    appointmentTime,
    valid: !problem,
    problem,
  };
}

function getBookingDateTimeLabel(appointment) {
  const dateValue = getAppointmentRecordDateValue(appointment?.appointment_date);
  if (!dateValue || !isValidAppointmentDateValue(dateValue)) return "Not selected";

  const date = formatAppointmentDateDisplay(dateValue);
  const timeRange = getAppointmentTimeRangeDisplay({ ...appointment, appointment_date: dateValue });
  if (timeRange !== "N/A") return `${date}, ${timeRange}`;
  const time = formatSuggestedAppointmentTimeDisplay(appointment?.appointment_time);
  return time ? `${date}, ${time}` : date;
}

function getBookingSummaryRowsHtml(rows) {
  return rows.map(([label, valueHtml]) => `
    <div>
      <dt class="text-xs font-semibold uppercase tracking-wide text-gray-500">${escapeHtml(label)}</dt>
      <dd class="mt-1 text-sm font-medium text-gray-700">${valueHtml}</dd>
    </div>
  `).join("");
}

function setDepositPanelText(id, text) {
  const element = document.getElementById(id);
  if (element && element.textContent !== text) element.textContent = text;
}

// Fills the "Appointment Deposit" section from the current selections and deposit state
function renderBookingSummary(draft = getBookingDraft(), { showHint = true } = {}) {
  const knownService = draft.serviceType && isKnownAppointmentServiceType(draft.serviceType);
  setDepositPanelText("depositPanelAmount", formatDepositAmount(depositPolicy));
  setDepositPanelText("bookingSummaryPet", draft.petName || "Not selected");
  setDepositPanelText("bookingSummaryService", draft.serviceType || "Not selected");
  setDepositPanelText("bookingSummaryDateTime", getBookingDateTimeLabel({
    appointment_date: draft.appointmentDate,
    appointment_time: draft.appointmentTime,
    estimated_duration_minutes: getAppointmentDurationMinutes(draft.serviceType),
  }));
  setDepositPanelText("bookingSummaryDuration", knownService ? getAppointmentDurationLabel(draft.serviceType) : "Not selected");

  const state = getDepositPanelState();
  const badge = document.getElementById("depositPaymentStatus");
  if (badge) {
    badge.className = `inline-flex rounded-full px-3 py-1 text-xs font-semibold ${DEPOSIT_STATUS_BADGE_CLASSES[state.tone]}`;
    setDepositPanelText("depositPaymentStatus", state.text);
  }
  const note = document.getElementById("depositPanelNote");
  if (note) {
    setDepositPanelText("depositPanelNote", state.note);
    note.classList.toggle("hidden", !state.note);
  }

  // What is still missing before "Continue to Secure Payment" can be used (the note covers unavailable payment)
  const hint = document.getElementById("bookingDetailsHint");
  if (!hint) return;
  const hintText = showHint && !bookingSummaryBusyStatus && isDepositCheckoutAvailable()
    ? BOOKING_DETAILS_HINTS[draft.problem] || ""
    : "";
  hint.textContent = hintText;
  hint.classList.toggle("hidden", !hintText);
}

function setBookingSummaryBusyStatus(text) {
  bookingSummaryBusyStatus = text || "";
  renderBookingSummary(getBookingDraft(), { showHint: false });
}

function setupBookingSummary() {
  ["petSelect", "serviceType", "appointmentDate", "appointmentTime"].forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener("change", updateAppointmentPetBookingState);
    input.addEventListener("input", updateAppointmentPetBookingState);
  });
}

// ==================== DEPOSIT PAYMENT STATE (BOOKING CARD) ====================

function getDepositResultElement() {
  let panel = document.getElementById("bookingPaymentResult");
  if (panel) return panel;

  const form = document.getElementById("appointmentForm");
  if (!form || !form.parentNode) return null;

  panel = document.createElement("div");
  panel.id = "bookingPaymentResult";
  panel.className = "hidden";
  form.parentNode.insertBefore(panel, form.nextSibling);

  panel.addEventListener("click", (event) => {
    const button = event.target.closest("[data-payment-result]");
    if (!button || !panel.contains(button) || button.dataset.loading === "true") return;

    const appointmentId = String(panel.dataset.appointmentId || "");
    const action = button.dataset.paymentResult;
    if (action === "new") {
      forgetDepositCheckout();
      hideDepositResult();
      resetAppointmentForm(form);
      getAppointmentPetSelect()?.focus();
      return;
    }
    if (!DEPOSIT_APPOINTMENT_ID_PATTERN.test(appointmentId)) return;
    if (action === "pay") retryDepositPayment(button, appointmentId);
    if (action === "check") recheckDepositPayment(button, appointmentId);
  });
  return panel;
}

// What the booking card says about an appointment's deposit: payment-status badge, message and actions offered.
// Payment statuses: Verifying payment / Paid / Payment pending / Checkout cancelled / Checkout expired / Payment failed /
// Awaiting payment / Not paid (appointment closed) / Refunded / Refund due / Status unavailable. The appointment status
// is shown apart (showDepositResult).
function getDepositResultView(appointment, deposit, { outcome = "", errorMessage = "", openFailed = false, checking = false } = {}) {
  if (checking) {
    return { tone: "info", status: "Verifying payment...", message: "Verifying your payment with PayMongo...", actions: [] };
  }
  if (!deposit || deposit.status === "unavailable") {
    return {
      tone: "neutral",
      status: "Status unavailable",
      message: errorMessage || "We could not check the deposit right now. Please try again in a moment.",
      actions: [{ action: "check", label: "Check payment status", primary: true }, { action: "new", label: "Book another appointment" }],
    };
  }

  const newBooking = { action: "new", label: "Book another appointment" };
  const appointmentStatus = getAppointmentStatusLabel(appointment?.status);
  if (deposit.status === "paid" && deposit.refund_required) {
    return { tone: "error", status: "Refund due", message: getDepositStatusMessage(deposit), actions: [newBooking] };
  }
  if (deposit.status === "paid") {
    const paidMessages = {
      Pending: "Payment verified. Your ₱100 deposit is confirmed, and your appointment is now pending admin approval. Paying does not approve it; we email you the clinic's decision.",
      Approved: "Payment verified, and the clinic has approved your appointment.",
      Completed: "Payment verified. This appointment is completed.",
      Cancelled: "This appointment was cancelled or declined by the clinic.",
    };
    return { tone: "success", status: "Paid", message: paidMessages[appointmentStatus] || paidMessages.Pending, actions: [newBooking] };
  }
  if (deposit.status === "refunded") {
    return { tone: "neutral", status: "Refunded", message: "The deposit for this appointment was refunded.", actions: [newBooking] };
  }
  if (deposit.status === "not_required") {
    return { tone: "neutral", status: "No deposit needed", message: getDepositStatusMessage(deposit), actions: [newBooking] };
  }
  if (appointmentStatus !== "Pending") {
    const closedMessage = appointmentStatus === "Cancelled"
      ? "This appointment was cancelled or declined by the clinic, so no deposit is due."
      : "This appointment is no longer waiting for a deposit.";
    return { tone: "neutral", status: "Not paid", message: closedMessage, actions: [newBooking] };
  }

  const unavailableNote = "Online payment is not available right now. Please try again later or contact the clinic.";
  const nextStep = deposit.can_pay ? " Retry the ₱100 deposit payment to complete it." : ` ${unavailableNote}`;
  const retry = label => (deposit.can_pay ? [{ action: "pay", label, primary: true }] : []);
  const left = outcome === "cancelled" || outcome === "left";

  if (deposit.status === "pending" && openFailed) {
    return {
      tone: "error",
      status: "Awaiting payment",
      message: `Your booking is not complete: the payment page could not be opened (${errorMessage || "please try again"}).${nextStep}`,
      actions: [...retry("Retry payment"), { action: "check", label: "Check payment status" }, newBooking],
    };
  }
  if (deposit.status === "pending" && left) {
    return {
      tone: "error",
      status: "Checkout cancelled",
      message: `Your booking is not complete: you left the payment page before paying.${nextStep}`,
      actions: [...retry("Retry payment"), { action: "check", label: "Check payment status" }, newBooking],
    };
  }
  if (deposit.status === "pending") {
    return {
      tone: "info",
      status: "Payment pending",
      message: "We have not received PayMongo's confirmation yet, so the booking is not complete yet. This can take a minute; check again shortly. Do not pay twice.",
      actions: [
        { action: "check", label: "Check payment status", primary: true },
        ...(deposit.can_pay ? [{ action: "pay", label: "Continue to Secure Payment — ₱100.00" }] : []),
        newBooking,
      ],
    };
  }

  // Unpaid: the checkout could not be opened, was left, expired or failed
  let status = "Awaiting payment";
  let reason = "the ₱100 deposit has not been paid yet.";
  if (openFailed) {
    reason = `the payment page could not be opened (${errorMessage || "please try again"}).`;
  } else if (left) {
    status = "Checkout cancelled";
    reason = "you left the payment page before paying.";
  } else if (deposit.last_checkout_status === "expired") {
    status = "Checkout expired";
    reason = "the checkout expired before payment.";
  } else if (deposit.last_checkout_status === "failed") {
    status = "Payment failed";
    reason = "the last checkout could not be completed.";
  }
  return {
    tone: "error",
    status,
    message: `Your booking is not complete: ${reason}${nextStep}`,
    actions: [...retry("Retry payment"), newBooking],
  };
}

function showDepositResult(appointment, deposit, options = {}) {
  const panel = getDepositResultElement();
  const form = document.getElementById("appointmentForm");
  if (!panel || !form) return;

  const view = getDepositResultView(appointment, deposit, options);
  panel.dataset.appointmentId = getDepositAppointmentId(appointment);
  // Appointment status and payment status are shown apart: an unverified deposit means the booking is incomplete
  const bookingStatus = getCustomerAppointmentStatus({ ...appointment, deposit: deposit || { required: true, status: "unavailable" } });
  const rows = appointment
    ? getBookingSummaryRowsHtml([
      ["Reference", escapeHtml(getAppointmentReference(appointment))],
      ["Pet", escapeHtml(appointment.pet_name || "N/A")],
      ["Service", escapeHtml(appointment.service_type || "N/A")],
      ["Date and time", escapeHtml(getBookingDateTimeLabel(appointment))],
      ["Deposit", escapeHtml(formatDepositPeso(deposit || depositPolicy))],
      ["Appointment status", `<span class="inline-flex rounded-full px-3 py-1 text-xs font-semibold ${getStatusClass(bookingStatus)}">${escapeHtml(bookingStatus)}</span>`],
      ["Payment status", `<span class="inline-flex rounded-full px-3 py-1 text-xs font-semibold ${DEPOSIT_STATUS_BADGE_CLASSES[view.tone]}">${escapeHtml(view.status)}</span>`],
    ])
    : "";

  panel.innerHTML = `
    <h3 id="bookingPaymentResultHeading" class="text-lg font-bold text-gray-900" tabindex="-1">Your booking</h3>
    ${rows ? `<dl class="mt-4 space-y-3">${rows}</dl>` : ""}
    <p class="mt-4 rounded-lg border p-3 text-sm ${DEPOSIT_NOTICE_CLASSES[view.tone] || "border-gray-200 bg-white text-gray-700"}" role="${view.tone === "error" ? "alert" : "status"}">
      ${escapeHtml(view.message)}
    </p>
    ${view.actions.length ? `
      <div class="mt-4 flex flex-col gap-2">
        ${view.actions.map(({ action, label, primary }) => `
          <button type="button" data-payment-result="${action}" class="${primary ? DEPOSIT_SUMMARY_PRIMARY_BUTTON_CLASS : DEPOSIT_CHECK_BUTTON_CLASS}">${escapeHtml(label)}</button>
        `).join("")}
      </div>
    ` : ""}
  `;

  form.classList.add("hidden");
  panel.classList.remove("hidden");
  if (!options.checking) document.getElementById("bookingPaymentResultHeading")?.focus();
}

function hideDepositResult() {
  const panel = document.getElementById("bookingPaymentResult");
  if (panel) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    delete panel.dataset.appointmentId;
  }
  document.getElementById("appointmentForm")?.classList.remove("hidden");
}

// Asks the backend for the deposit state (never trusting the redirect) and shows it with the appointment's details
async function refreshDepositResult(appointmentId, options = {}) {
  let deposit = null;
  let errorMessage = options.errorMessage || "";
  try {
    deposit = await fetchDepositStatus(appointmentId);
  } catch (error) {
    errorMessage = errorMessage || error.message;
  }

  const appointments = await loadAppointments(currentUser.id);
  const appointment = appointments.find(item => String(item?.id || "") === appointmentId) || null;
  if (!appointment) {
    // Not one of this customer's appointments (or the list did not load): the list area explains the rest
    forgetDepositCheckout();
    hideDepositResult();
    if (deposit) showDepositNotice(getDepositStatusMessage(deposit, options.outcome), deposit.status === "paid" ? "success" : "info");
    else if (errorMessage) showDepositNotice(errorMessage, "error");
    return;
  }

  const settled = deposit && (["paid", "refunded", "not_required"].includes(deposit.status) ||
    getAppointmentStatusLabel(appointment.status) !== "Pending");
  if (settled) forgetDepositCheckout();
  showDepositResult(appointment, deposit, { ...options, errorMessage });
}

function setDepositResultButtonsBusy(activeButton, loadingText) {
  updateButtonState(activeButton, true, loadingText);
  activeButton.parentNode?.querySelectorAll("button").forEach((button) => {
    if (button !== activeButton) button.disabled = true;
  });
}

async function retryDepositPayment(button, appointmentId) {
  setDepositResultButtonsBusy(button, "Preparing secure checkout...");
  try {
    const checkoutUrl = await requestDepositCheckout(appointmentId);
    rememberDepositCheckout(appointmentId);
    updateButtonState(button, true, "Redirecting to PayMongo...");
    window.location.assign(checkoutUrl);
  } catch (error) {
    console.error("Deposit checkout error:", error);
    await refreshDepositResult(appointmentId, { errorMessage: error.message, openFailed: true });
  }
}

async function recheckDepositPayment(button, appointmentId) {
  setDepositResultButtonsBusy(button, "Checking...");
  await refreshDepositResult(appointmentId, { outcome: "return" });
}

function resetAppointmentForm(form) {
  form.reset();
  clearServiceDurationHint();
  clearAppointmentDateTimeErrors();
  setAppointmentDateAvailabilityNote("");
  applyAppointmentDateMin();
  applyAppointmentTimeMin();
  updateAppointmentPetBookingState();
}

/**
 * Books the appointment (POST /appointments/create) and continues straight to its ₱100 deposit PayMongo checkout;
 * if that cannot open, the appointment is kept (not complete) and the booking card offers a retry.
 * Sending the same booking again returns the existing appointment (already_booked), so its checkout is resumed.
 * Only called once the deposit policy says the deposit can be paid online.
 */
async function bookAppointment(details) {
  const form = document.getElementById("appointmentForm");
  const messageContainer = document.getElementById("messageContainer");
  if (!form || appointmentSubmitInProgress) return;

  appointmentSubmitInProgress = true;
  setFormSubmitting(form, true, "Saving your booking...", "Continue to Secure Payment — ₱100.00");
  setBookingSummaryBusyStatus("Saving your booking...");
  let redirecting = false;

  try {
    // Convert time format from HH:MM to HH:MM:SS for PostgreSQL
    let formattedTime = details.appointmentTime;
    if (formattedTime.length === 5) {
      formattedTime = formattedTime + ":00";
    }

    // Send POST request
    const response = await fetch(`${window.API_BASE_URL}/appointments/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: currentUser.id,
        pet_id: details.petId,
        pet_name: details.petName,
        service_type: details.serviceType,
        appointment_date: details.appointmentDate,
        appointment_time: formattedTime,
      }),
    });

    const data = await response.json().catch(() => ({}));

    // Check response
    if (!response.ok) {
      const bookingError = new Error(data.error || "Could not book appointment.");
      bookingError.suggestedTime = data.suggested_time;
      throw bookingError;
    }

    const deposit = data.deposit && data.deposit.required ? data.deposit : null;
    const appointmentId = getDepositAppointmentId(data.appointment);
    // The details shown on the booking card if the payment cannot continue right away
    const bookedAppointment = {
      ...data.appointment,
      pet_name: data.appointment?.pet_name || details.petName,
      service_type: data.appointment?.service_type || details.serviceType,
      appointment_date: data.appointment?.appointment_date || details.appointmentDate,
      appointment_time: data.appointment?.appointment_time || details.appointmentTime,
      estimated_duration_minutes: data.appointment?.estimated_duration_minutes || getAppointmentDurationMinutes(details.serviceType),
      status: data.appointment?.status || "Pending",
    };

    if (deposit && appointmentId) {
      rememberDepositCheckout(appointmentId);
      if (!deposit.can_pay) {
        // Nothing to pay right now (the same booking sent again after its deposit was paid, or online payment
        // became unavailable meanwhile): the booking card shows the deposit state the backend reports
        resetAppointmentForm(form);
        hideAppointmentFeedback(messageContainer);
        await refreshDepositResult(appointmentId, { outcome: "return" });
        return;
      }

      setBookingSummaryBusyStatus("Preparing secure checkout...");
      updateButtonState(getAppointmentSubmitButton(), true, "Preparing secure checkout...");
      showAppointmentFeedback(
        messageContainer,
        data.already_booked
          ? "You already started this booking. Preparing its secure PayMongo checkout..."
          : "Booking details saved. Preparing your secure PayMongo checkout; the booking is complete once the deposit is verified...",
        "success"
      );
      try {
        const checkoutUrl = await requestDepositCheckout(appointmentId);
        redirecting = true;
        setBookingSummaryBusyStatus("Redirecting to PayMongo...");
        updateButtonState(getAppointmentSubmitButton(), true, "Redirecting to PayMongo...");
        window.location.assign(checkoutUrl);
      } catch (checkoutError) {
        console.error("Deposit checkout error:", checkoutError);
        resetAppointmentForm(form);
        hideAppointmentFeedback(messageContainer);
        showDepositResult(bookedAppointment, deposit, { errorMessage: checkoutError.message, openFailed: true });
        await refreshDepositResult(appointmentId, { errorMessage: checkoutError.message, openFailed: true });
      }
      return;
    }

    // The server booked it without a deposit (deposits were switched off after this page loaded), so the page says
    // exactly that rather than reporting a paid booking; the reloaded list then shows online payment as unavailable
    resetAppointmentForm(form);
    let bookedMessage = data.already_booked
      ? "You already booked this appointment."
      : "Appointment booked. No deposit was required for this booking; it is pending clinic approval.";
    if (deposit) {
      bookedMessage = "Your booking is not complete until the ₱100 deposit is paid. Pay it from your appointments list.";
    }
    showAppointmentFeedback(messageContainer, bookedMessage, "success");
    if (typeof showSuccess === "function") showSuccess(bookedMessage);

    await loadAppointments(currentUser.id);
    setTimeout(() => hideAppointmentFeedback(messageContainer), 4000);
  } catch (error) {
    // Nothing was booked: the form still holds the customer's choices
    console.error("Booking error:", error);
    const errorMessage = getAppointmentBookingErrorMessage(error);
    applyServerAppointmentDateTimeError(errorMessage);
    showAppointmentFeedback(messageContainer, errorMessage, "error");
    if (!error?.suggestedTime && typeof showError === "function") showError(errorMessage);
  } finally {
    // While the browser leaves for PayMongo the controls stay busy, so the checkout cannot be started twice
    if (!redirecting) {
      appointmentSubmitInProgress = false;
      bookingSummaryBusyStatus = "";
      setFormSubmitting(form, false, "Saving your booking...", "Continue to Secure Payment — ₱100.00");
      updateSubmitButtonLabel();
      updateAppointmentPetBookingState();
    }
  }
}

/**
 * Setup form submission handler
 */
function setupFormHandler() {
  const form = document.getElementById("appointmentForm");
  const messageContainer = document.getElementById("messageContainer");

  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (appointmentSubmitInProgress || isFormSubmitting(form)) return;

    applyAppointmentDateMin();

    hideAppointmentFeedback(messageContainer);

    // Get form values
    const selectedPetId = getAppointmentPetSelect()?.value.trim() || "";
    const selectedPet = getAppointmentPetById(selectedPetId);
    const petName = String(selectedPet?.name || "").trim();
    const serviceType = document.getElementById("serviceType").value.trim();
    const appointmentDate = document.getElementById("appointmentDate").value;
    const appointmentTime = document.getElementById("appointmentTime").value;

    if (appointmentPetsError) {
      showAppointmentFeedback(messageContainer, appointmentPetsError, "error");
      return;
    }

    if (appointmentPetsLoaded && currentUserPets.length === 0) {
      showAppointmentFeedback(messageContainer, NO_APPOINTMENT_PETS_MESSAGE, "error");
      updateAppointmentPetBookingState();
      return;
    }

    if (!appointmentPetsLoaded) {
      showAppointmentFeedback(messageContainer, "Please wait while your pets load.", "error");
      updateAppointmentPetBookingState();
      return;
    }

    if (!selectedPet || !petName) {
      showAppointmentFeedback(messageContainer, "Select one of your registered pets.", "error");
      return;
    }

    // Validation: Check all required fields
    if (!selectedPetId || !serviceType || !appointmentDate || !appointmentTime) {
      showAppointmentFeedback(messageContainer, "All fields are required.", "error");
      return;
    }

    if (!isKnownAppointmentServiceType(serviceType)) {
      showAppointmentFeedback(messageContainer, "Select a valid service type.", "error");
      return;
    }

    const appointmentDateTimeValidation = updateAppointmentDateTimeValidation({ showFeedback: true });
    if (appointmentDateTimeValidation.message) {
      showAppointmentDateTimeError(messageContainer, appointmentDateTimeValidation.message);
      return;
    }

    const bookingDetails = { petId: selectedPetId, petName, serviceType, appointmentDate, appointmentTime };

    // The deposit section has shown the booking and the ₱100 deposit; the form only books together with its checkout,
    // so nothing is booked while the deposit cannot be paid online (or that is not confirmed yet)
    if (!isDepositCheckoutAvailable()) {
      showAppointmentFeedback(
        messageContainer,
        depositPolicyState === "checking" ? DEPOSIT_AVAILABILITY_CHECKING_MESSAGE : getDepositPanelState().note || DEPOSIT_BOOKING_UNAVAILABLE_MESSAGE,
        "error"
      );
      return;
    }
    if (bookingSlotUnavailable) {
      showAppointmentFeedback(messageContainer, BOOKING_DETAILS_HINTS.unavailable, "error");
      return;
    }
    await bookAppointment(bookingDetails);
  });
}

function showAppointmentFeedback(container, message, type) {
  if (!container) return;
  displayMessage(container, message, type);
  container.classList.remove("hidden");
}

function hideAppointmentFeedback(container) {
  if (!container) return;
  clearMessage(container);
  container.classList.add("hidden");
}
