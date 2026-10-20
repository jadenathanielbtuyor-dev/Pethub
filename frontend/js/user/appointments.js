// PetHub User Appointments

// Module-level user variable
let currentUser = null;
let currentUserPets = [];
let appointmentPetsLoaded = false;
let appointmentPetsError = "";
let appointmentSubmitInProgress = false;
let appointmentDateAvailabilityRequestId = 0;
let appointmentDateAvailabilityController = null;
// The clinic's services come from the server (GET /appointments/services) into window.AppointmentDurations
let serviceCatalogLoaded = false;
let serviceCatalogError = "";
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
const BOOKING_DETAILS_HINTS = {
  incomplete: "Choose a pet, service, date and time to continue.",
  invalid: "Fix the date or time above to continue.",
  unavailable: "That time is unavailable. Choose another time to continue.",
};
// Whether the availability check flagged the selected time as taken
let bookingSlotUnavailable = false;

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
  renderServiceOptions();
  updateAppointmentPetBookingState();
  loadServiceCatalog();
  loadAppointmentPets(currentUser.id);
  // Which services can be chosen depends on the selected pet's species
  getAppointmentPetSelect()?.addEventListener("change", renderServiceOptions);
  setupBookingSummary();
  loadAppointments(currentUser.id);
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

function getSelectedPetSpecies() {
  return String(getAppointmentPetById(getAppointmentPetSelect()?.value)?.species || "").trim();
}

// A service that can be booked for the selected pet: in the clinic's catalog, with a confirmed duration, and offered
// for the pet's species (the server checks all three again)
function isKnownAppointmentServiceType(serviceType) {
  const catalog = window.AppointmentDurations;
  if (!catalog || !catalog.hasService(serviceType) || !catalog.isBookable(serviceType)) return false;
  const species = getSelectedPetSpecies();
  return !species || catalog.isAvailableForSpecies(serviceType, species);
}

function getSpeciesPluralLabel(species) {
  return `${String(species).toLowerCase()}s`;
}

async function loadServiceCatalog() {
  serviceCatalogLoaded = false;
  serviceCatalogError = "";
  renderServiceOptions();

  try {
    const response = await fetch(`${window.API_BASE_URL}/appointments/services`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false || !Array.isArray(data.services)) {
      throw new Error(data.error || `Failed to load services (${response.status})`);
    }
    window.AppointmentDurations.setCatalog(data.services);
  } catch (error) {
    console.error("Error loading services:", error);
    serviceCatalogError = "We could not load the clinic's services. Please refresh the page to try again.";
  }

  serviceCatalogLoaded = true;
  renderServiceOptions();
  applyRequestedService();
}

// A "Book" link on the Services page names its service (?service=Bath); it is chosen once the list has loaded, if it
// can be booked
function applyRequestedService() {
  const requested = new URLSearchParams(window.location.search).get("service");
  const select = document.getElementById("serviceType");
  if (!requested || !select || select.value) return;
  if (!isKnownAppointmentServiceType(requested)) return;
  select.value = requested;
  select.dispatchEvent(new Event("change"));
}

// The service list, grouped by category. Services that cannot be booked for the selected pet stay visible but
// disabled, with the reason in their label.
function renderServiceOptions() {
  const select = document.getElementById("serviceType");
  const catalog = window.AppointmentDurations;
  if (!select || !catalog) return;

  const previousValue = select.value;
  const species = getSelectedPetSpecies();
  select.innerHTML = "";
  select.appendChild(new Option(
    serviceCatalogError ? "Unable to load services" : !serviceCatalogLoaded ? "Loading services..." : "Select Service",
    ""
  ));

  const groups = new Map();
  catalog.getServices().forEach((service) => {
    let group = groups.get(service.category);
    if (!group) {
      group = document.createElement("optgroup");
      group.label = service.categoryLabel;
      groups.set(service.category, group);
      select.appendChild(group);
    }

    const option = new Option(service.name, service.name);
    let reason = "";
    if (!catalog.isBookable(service.name)) reason = "online booking not open yet";
    else if (species && !catalog.isAvailableForSpecies(service.name, species)) reason = `not offered for ${getSpeciesPluralLabel(species)}`;
    if (reason) {
      option.disabled = true;
      option.textContent = `${service.name} (${reason})`;
    }
    group.appendChild(option);
  });

  select.disabled = Boolean(serviceCatalogError) || !serviceCatalogLoaded;
  if (previousValue && isKnownAppointmentServiceType(previousValue)) select.value = previousValue;
  updateServiceTypeHint();
  select.dispatchEvent(new Event("change"));
}

// Under the service list: why services are unavailable, or what the selected service is
function updateServiceTypeHint() {
  const hint = document.getElementById("serviceTypeHint");
  const catalog = window.AppointmentDurations;
  if (!hint || !catalog) return;

  const services = catalog.getServices();
  const selected = catalog.getService(document.getElementById("serviceType")?.value);
  const species = getSelectedPetSpecies();
  let text = "";
  let isError = false;
  if (serviceCatalogError) {
    text = serviceCatalogError;
    isError = true;
  } else if (serviceCatalogLoaded && services.length > 0 && !services.some(service => catalog.isBookable(service.name))) {
    text = "Online booking opens once the clinic confirms how long each service takes. Until then, please contact the clinic to book.";
  } else if (selected) {
    text = selected.description;
  } else if (species && services.some(service => catalog.isBookable(service.name) && !catalog.isAvailableForSpecies(service.name, species))) {
    text = `Services marked "not offered for ${getSpeciesPluralLabel(species)}" can't be booked for this pet.`;
  }

  hint.textContent = text;
  hint.classList.toggle("hidden", !text);
  hint.classList.toggle("text-red-600", isError);
  hint.classList.toggle("text-slate-500", !isError);
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
  serviceInput.addEventListener("change", updateServiceTypeHint);
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
  // "Book Appointment" stays disabled until the booking details are complete and valid
  const bookingDraft = getBookingDraft();
  const shouldDisableSubmit = shouldDisableBooking || !bookingDraft.valid;

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
    displayAppointments(appointments);
    return appointments;
  } catch (error) {
    console.error("Error loading appointments:", error);
    if (container) {
      container.innerHTML = getUserAppointmentsErrorHtml(error.message);
    }
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
      const status = getAppointmentStatusLabel(apt.status);
      const handledByRow = handledBy
        ? `
          <div>
            <dt class="text-xs font-semibold uppercase tracking-wide text-gray-500">Handled by</dt>
            <dd class="mt-1 text-sm font-medium text-gray-700">${escapeHtml(handledBy)}</dd>
          </div>
        `
        : "";
      return `
        <div class="rounded-lg border border-gray-100 bg-white p-5 shadow-sm">
          <dl class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt class="text-xs font-semibold uppercase tracking-wide text-gray-500">Reference</dt>
              <dd class="mt-1 text-sm font-semibold text-gray-700">${escapeHtml(getAppointmentReference(apt))}</dd>
            </div>
            <div>
              <dt class="text-xs font-semibold uppercase tracking-wide text-gray-500">Pet</dt>
              <dd class="mt-1 text-sm font-semibold text-gray-900">${escapeHtml(apt.pet_name || 'N/A')}</dd>
            </div>
            <div>
              <dt class="text-xs font-semibold uppercase tracking-wide text-gray-500">Service</dt>
              <dd class="mt-1 text-sm font-medium text-gray-700">${escapeHtml(apt.service_type || 'N/A')}</dd>
            </div>
            <div>
              <dt class="text-xs font-semibold uppercase tracking-wide text-gray-500">Duration</dt>
              <dd class="mt-1 text-sm font-medium text-gray-700">${escapeHtml(getAppointmentDisplayDuration(apt))}</dd>
            </div>
            <div>
              <dt class="text-xs font-semibold uppercase tracking-wide text-gray-500">Date</dt>
              <dd class="mt-1 text-sm font-medium text-gray-700">${escapeHtml(formatAppointmentDateDisplay(apt.appointment_date))}</dd>
            </div>
            <div>
              <dt class="text-xs font-semibold uppercase tracking-wide text-gray-500">Time range</dt>
              <dd class="mt-1 text-sm font-medium text-gray-700">${escapeHtml(getAppointmentTimeRangeDisplay(apt))}</dd>
            </div>
            <div>
              <dt class="text-xs font-semibold uppercase tracking-wide text-gray-500">Status</dt>
              <dd class="mt-1">
                <span class="inline-flex rounded-full px-3 py-1 text-xs font-semibold ${getStatusClass(status)}">
                  ${escapeHtml(status)}
                </span>
              </dd>
            </div>
            ${handledByRow}
          </dl>
        </div>
      `;
    })
    .join("");
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
// Status badge colours (assets/css/input.css .ph-status-*), readable in both themes
function getStatusClass(status) {
  const statusClasses = {
    Approved: "ph-status ph-status-approved",
    Cancelled: "ph-status ph-status-cancelled",
    Completed: "ph-status ph-status-completed",
    Pending: "ph-status ph-status-pending",
  };
  return statusClasses[status] || "ph-status ph-status-other";
}

// A short reference to quote to the clinic: the stored appointment_reference is empty, so it is derived from the id
function getAppointmentReference(appointment) {
  const compactId = String(appointment?.id || "").replace(/[^A-Za-z0-9]/g, "");
  return compactId ? `PH-${compactId.slice(0, 8).toUpperCase()}` : "N/A";
}

// ==================== BOOKING SUMMARY ====================
// The booking form's summary (pages/user/appointments.html) shows the selected pet, service, date and time and the
// estimated duration. "Book Appointment" is enabled once they are complete and valid.

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

function setBookingSummaryText(id, text) {
  const element = document.getElementById(id);
  if (element && element.textContent !== text) element.textContent = text;
}

// Fills the booking summary from the current selections
function renderBookingSummary(draft = getBookingDraft(), { showHint = true } = {}) {
  const knownService = draft.serviceType && isKnownAppointmentServiceType(draft.serviceType);
  setBookingSummaryText("bookingSummaryPet", draft.petName || "Not selected");
  setBookingSummaryText("bookingSummaryService", draft.serviceType || "Not selected");
  setBookingSummaryText("bookingSummaryDateTime", getBookingDateTimeLabel({
    appointment_date: draft.appointmentDate,
    appointment_time: draft.appointmentTime,
    estimated_duration_minutes: getAppointmentDurationMinutes(draft.serviceType),
  }));
  setBookingSummaryText("bookingSummaryDuration", knownService ? getAppointmentDurationLabel(draft.serviceType) : "Not selected");

  // What is still missing before "Book Appointment" can be used
  const hint = document.getElementById("bookingDetailsHint");
  if (!hint) return;
  const hintText = showHint && !appointmentSubmitInProgress
    ? BOOKING_DETAILS_HINTS[draft.problem] || ""
    : "";
  hint.textContent = hintText;
  hint.classList.toggle("hidden", !hintText);
}

function setupBookingSummary() {
  ["petSelect", "serviceType", "appointmentDate", "appointmentTime"].forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener("change", updateAppointmentPetBookingState);
    input.addEventListener("input", updateAppointmentPetBookingState);
  });
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
 * Books the appointment (POST /appointments/create). The backend validates it again and returns the existing Pending
 * appointment (already_booked) if the same booking was already sent, so a repeated submit never creates a duplicate.
 */
async function bookAppointment(details) {
  const form = document.getElementById("appointmentForm");
  const messageContainer = document.getElementById("messageContainer");
  if (!form || appointmentSubmitInProgress) return;

  appointmentSubmitInProgress = true;
  setFormSubmitting(form, true, "Booking...", "Book Appointment");
  renderBookingSummary(getBookingDraft(), { showHint: false });

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

    resetAppointmentForm(form);
    const bookedMessage = data.already_booked
      ? "You already booked this appointment."
      : "Appointment booked. It is pending clinic approval.";
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
    appointmentSubmitInProgress = false;
    setFormSubmitting(form, false, "Booking...", "Book Appointment");
    updateAppointmentPetBookingState();
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
      showAppointmentFeedback(messageContainer, "Choose a service that can be booked for this pet.", "error");
      return;
    }

    const appointmentDateTimeValidation = updateAppointmentDateTimeValidation({ showFeedback: true });
    if (appointmentDateTimeValidation.message) {
      showAppointmentDateTimeError(messageContainer, appointmentDateTimeValidation.message);
      return;
    }

    const bookingDetails = { petId: selectedPetId, petName, serviceType, appointmentDate, appointmentTime };

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
