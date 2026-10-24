// PetHub Pet Owner Dashboard: Appointments (pages/user/appointments.html)
//
// Section 3 of the Pet Owner Dashboard.
// - List: GET /appointments/userAppointments?user_id= returns only this owner's appointments (requireAuth matches
//   user_id to the session token; another owner's id gets 403). Upcoming / History / All and the status filter are
//   applied in the browser to that list; statuses are the backend's own values (Pending, Approved, Completed,
//   Cancelled) and are never changed here.
// - Booking: GET /appointments/services lists the clinic's nine services; POST /appointments/create books one.
//   The pet is one of the owner's registered profiles (GET /pets/userPets; ?pet=<id> from My Pets preselects it) and
//   is sent as its pet_id, which the server checks belongs to the owner; booking never creates a pet.
//   The flow: the owner picks a pet, service, date and time -> the form checks them (service bookable for the pet's
//   species, date and time not in the past, slot not already taken by a Pending, Approved or Completed appointment)
//   -> the server checks everything again, including that the clinic has confirmed the service's duration (409 until
//   it has) and that the slot is free (409 with a suggested time) -> on success the appointment is saved as Pending
//   and the list is reloaded
//   from the server; on failure nothing is saved and the form keeps the owner's choices.
// - Owners may cancel their own Pending or Approved appointments at least two hours before clinic-local start.
//   The server recomputes this cutoff and conditionally updates only the current owner/status; the browser countdown
//   is explanatory and never authorizes the change. Rescheduling remains clinic-managed.

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
let serviceCardClickBound = false;
const NO_APPOINTMENT_PETS_MESSAGE = "Please add a pet first before booking an appointment.";
const INVALID_APPOINTMENT_DATE_MESSAGE = "Enter a valid appointment date.";
const INVALID_APPOINTMENT_TIME_MESSAGE = "Enter a valid appointment time.";
const PAST_APPOINTMENT_DATE_MESSAGE = "Appointment date cannot be in the past.";
const PAST_APPOINTMENT_TIME_MESSAGE = "Appointment time must be later than the current time when booking for today.";
const APPOINTMENT_DATE_AVAILABILITY_NOTE = "That slot is unavailable. Choose another time.";
const OCCUPIED_APPOINTMENT_STATUSES = new Set(["pending", "approved", "completed"]);
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
// The list as the server last returned it, and the filters applied to it in the browser
let loadedAppointments = [];
const appointmentListFilter = { when: "upcoming", status: "all" };
const UPCOMING_APPOINTMENT_STATUSES = ["Pending", "Approved"];
const CLINIC_TIME_ZONE = "Asia/Manila";
const APPOINTMENT_CANCEL_CUTOFF_MS = 2 * 60 * 60 * 1000;
const appointmentCancellationInProgress = new Set();

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
  setupPetPicker();
  renderAppointmentPetOptions();
  renderServiceOptions();
  updateAppointmentPetBookingState();
  loadServiceCatalog();
  loadAppointmentPets(currentUser.id);
  // Which services can be chosen depends on the selected pet's species
  getAppointmentPetSelect()?.addEventListener("change", renderServiceOptions);
  setupBookingSummary();
  setupAppointmentFilters();
  loadAppointments(currentUser.id);
  setupFormHandler();
}

function getTodayDateValue(date = new Date()) {
  const parts = clinicDateTimeParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getTimeInputValue(date = new Date()) {
  const parts = clinicDateTimeParts(date);
  return `${parts.hour}:${parts.minute}`;
}

function clinicDateTimeParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: CLINIC_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function clinicLocalDateTime(dateValue, timeValue) {
  const dateMatch = String(dateValue || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = String(timeValue || "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!dateMatch || !timeMatch) return null;
  const [year, month, day] = dateMatch.slice(1).map(Number);
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const seconds = Number(timeMatch[3] || 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59 || seconds > 59) return null;

  const targetWallMs = Date.UTC(year, month - 1, day, hours, minutes, seconds);
  let candidateMs = targetWallMs;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = clinicDateTimeParts(new Date(candidateMs));
    const representedWallMs = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const correction = targetWallMs - representedWallMs;
    candidateMs += correction;
    if (correction === 0) break;
  }
  const verified = clinicDateTimeParts(new Date(candidateMs));
  return Number(verified.year) === year && Number(verified.month) === month && Number(verified.day) === day &&
    Number(verified.hour) === hours && Number(verified.minute) === minutes && Number(verified.second) === seconds
    ? new Date(candidateMs)
    : null;
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
  updateBookingClosedNotice();
}

// When the list loaded and no service can be booked online right now, the "temporarily unavailable" notice replaces
// the booking form (a form that cannot be completed is not shown). A failed load keeps the form with its error message.
function updateBookingClosedNotice() {
  const notice = document.getElementById("bookingClosedNotice");
  const form = document.getElementById("appointmentForm");
  const catalog = window.AppointmentDurations;
  if (!notice || !catalog) return;
  const closed = serviceCatalogLoaded && !serviceCatalogError
    && !catalog.getServices().some(service => catalog.isBookable(service.name));
  notice.hidden = !closed;
  if (form) form.hidden = closed;
}

// A "Book" link on the Services page names its service (?service=<id>); it is chosen once the list has loaded, if it
// can be booked
function applyRequestedService() {
  const requested = new URLSearchParams(window.location.search).get("service");
  const select = document.getElementById("serviceType");
  if (!requested || !select || select.value) return;
  const requestedService = window.AppointmentDurations?.getService(requested);
  if (!requestedService || !isKnownAppointmentServiceType(requestedService.name)) return;
  select.value = requestedService.name;
  select.dispatchEvent(new Event("change"));
}

// The hidden select behind the service cards, grouped by category. It keeps every service (those that cannot be
// booked for the selected pet are disabled, with the reason), so validation and the summary see the whole catalog;
// the visible cards list only what can be booked.
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
  renderServiceCards(catalog, species, select.value);
  updateServiceTypeHint();
  select.dispatchEvent(new Event("change"));
}

function setServiceUnavailableNote(visible) {
  const note = document.getElementById("serviceUnavailableNote");
  if (note) note.hidden = !visible;
}

function getServiceSpeciesText(service) {
  if (service.species.includes("Dog") && service.species.includes("Cat")) return "Dogs and cats";
  return service.species.map(species => `${species}s`).join(", ") + " only";
}

function getServiceCardHtml(catalog, service, selectedService) {
  const selected = service.name === selectedService;
  const stateClass = selected ? "border-orange-500 bg-orange-50" : "border-slate-200 bg-white hover:border-orange-300";
  // The category is the heading of the card's group, so the card itself shows duration and species
  const details = [catalog.formatDuration(service.name), getServiceSpeciesText(service)];
  return `<button type="button" class="service-choice-card w-full rounded-xl border-2 px-3 py-2.5 text-left transition-colors cursor-pointer ${stateClass}" data-service-name="${escapeHtml(service.name)}" data-service-id="${escapeHtml(service.id)}" aria-pressed="${selected}">
      <span class="flex items-start justify-between gap-2"><strong class="text-sm font-semibold text-slate-900">${escapeHtml(service.name)}</strong><i class="${selected ? "ri-checkbox-circle-fill text-orange-600" : "ri-checkbox-blank-circle-line text-slate-400"} text-lg leading-none" aria-hidden="true"></i></span>
      ${service.description ? `<span class="mt-1 block text-xs text-slate-600 line-clamp-2">${escapeHtml(service.description)}</span>` : ""}
      <span class="mt-2 block text-xs font-medium text-slate-600">${details.map(escapeHtml).join(" · ")}</span>
    </button>`;
}

// The visible choice: only services open for online booking (and, once a pet is chosen, offered for its species),
// grouped by category. Switched-off services are left out; a short note says some are unavailable.
function renderServiceCards(catalog, species, selectedService) {
  const container = document.getElementById("serviceCardList");
  if (!container) return;
  if (serviceCatalogError) {
    setServiceUnavailableNote(false);
    container.innerHTML = `<p class="ph-dash-error-text" role="alert">${escapeHtml(serviceCatalogError)}</p>`;
    return;
  }
  if (!serviceCatalogLoaded) {
    container.innerHTML = '<p class="ph-dash-note" role="status">Loading clinic services...</p>';
    return;
  }
  const services = catalog.getServices();
  const bookable = services.filter(service => catalog.isBookable(service.name));
  setServiceUnavailableNote(bookable.length > 0 && bookable.length < services.length);
  if (!bookable.length) {
    // The "temporarily unavailable" notice replaces the form (updateBookingClosedNotice)
    container.innerHTML = "";
    return;
  }
  const shown = species ? bookable.filter(service => catalog.isAvailableForSpecies(service.name, species)) : bookable;
  if (!shown.length) {
    container.innerHTML = `<p class="ph-dash-note" role="status">No service can be booked online for ${escapeHtml(getSpeciesPluralLabel(species))} right now. Choose another pet or <a href="../public/contact.html" class="ph-link-arrow">contact the clinic</a>.</p>`;
    return;
  }
  const groups = [];
  shown.forEach(service => {
    let group = groups.find(entry => entry.category === service.category);
    if (!group) {
      group = { category: service.category, label: service.categoryLabel || service.category, services: [] };
      groups.push(group);
    }
    group.services.push(service);
  });
  container.innerHTML = groups.map(group => `
    <div class="service-choice-group">
      <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">${escapeHtml(group.label)}</p>
      <div class="grid gap-2 grid-cols-[repeat(auto-fill,minmax(13rem,1fr))]">${group.services.map(service => getServiceCardHtml(catalog, service, selectedService)).join("")}</div>
    </div>`).join("");

  if (!serviceCardClickBound) {
    container.addEventListener("click", event => {
      const card = event.target.closest("[data-service-name]");
      if (!card || card.disabled) return;
      const select = document.getElementById("serviceType");
      if (!select) return;
      select.value = card.dataset.serviceName;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      renderServiceCards(catalog, getSelectedPetSpecies(), select.value);
    });
    serviceCardClickBound = true;
  }
}

// Under the service list: a load error, or what the selected service is
function updateServiceTypeHint() {
  const hint = document.getElementById("serviceTypeHint");
  const catalog = window.AppointmentDurations;
  if (!hint || !catalog) return;

  const selected = catalog.getService(document.getElementById("serviceType")?.value);
  let text = "";
  let isError = false;
  if (serviceCatalogError) {
    text = serviceCatalogError;
    isError = true;
  } else if (selected) {
    text = selected.description;
  }

  hint.textContent = text;
  hint.classList.toggle("hidden", !text);
  hint.classList.toggle("text-red-600", isError);
  hint.classList.toggle("text-slate-500", !isError);
}

function parseAppointmentDateTime(dateValue, timeValue) {
  return clinicLocalDateTime(dateValue, timeValue);
}

function getEstimatedAppointmentEndTime(serviceType, dateValue, timeValue) {
  const durationMinutes = getAppointmentDurationMinutes(serviceType);
  const startTime = parseAppointmentDateTime(dateValue, timeValue);
  if (!Number.isFinite(durationMinutes) || !startTime) return "";

  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);
  return endTime.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: CLINIC_TIME_ZONE,
  });
}

function formatAppointmentDateDisplay(dateValue) {
  const match = String(dateValue || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "N/A";

  const appointmentDate = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(appointmentDate.getTime())) return "N/A";
  return appointmentDate.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function getAppointmentTimeRangeDisplay(appointment) {
  const durationMinutes = getStoredAppointmentDurationMinutes(appointment);
  const startTime = parseAppointmentDateTime(appointment?.appointment_date, appointment?.appointment_time);
  if (!Number.isFinite(durationMinutes) || !startTime) return "N/A";

  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);
  const formatOptions = { hour: "numeric", minute: "2-digit", timeZone: CLINIC_TIME_ZONE };
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

  return new Date(Date.UTC(2000, 0, 1, hours, minutes, seconds)).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
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
  renderPetPicker();
}

function setupPetPicker() {
  const dialog = document.getElementById("petPickerDialog");
  const openButton = document.getElementById("choosePetButton");
  const closeButton = document.getElementById("closePetPicker");
  const list = document.getElementById("petPickerList");
  if (!dialog || !openButton || !list) return;

  openButton.addEventListener("click", () => {
    if (appointmentPetsError) return;
    if (!dialog.open) dialog.showModal();
  });
  closeButton?.addEventListener("click", () => dialog.close());
  list.addEventListener("click", event => {
    const option = event.target.closest("[data-pet-picker-id]");
    if (!option) return;
    const petSelect = getAppointmentPetSelect();
    if (!petSelect || !getAppointmentPetById(option.dataset.petPickerId)) return;
    petSelect.value = option.dataset.petPickerId;
    petSelect.dispatchEvent(new Event("change", { bubbles: true }));
    dialog.close();
  });
}

function renderPetPicker() {
  const list = document.getElementById("petPickerList");
  const chosenLabel = document.getElementById("chosenPetLabel");
  const openButton = document.getElementById("choosePetButton");
  const petSelect = getAppointmentPetSelect();
  if (chosenLabel) {
    const selectedPet = getAppointmentPetById(petSelect?.value);
    chosenLabel.textContent = selectedPet
      ? `${selectedPet.name} · ${[selectedPet.species, selectedPet.breed].filter(Boolean).join(" / ")}`
      : appointmentPetsError ? "Unable to load your pets" : !appointmentPetsLoaded ? "Loading your pets..." : "Choose a pet";
  }
  if (openButton) openButton.disabled = Boolean(appointmentPetsError);
  if (!list) return;
  if (appointmentPetsError) {
    list.innerHTML = `<p class="ph-dash-error-text" role="alert">${escapeHtml(appointmentPetsError)}</p>`;
    return;
  }
  if (!appointmentPetsLoaded) {
    list.innerHTML = `<div class="dashboard-loading-state" role="status"><div class="dashboard-loading-spinner" aria-hidden="true"></div><p>Loading your pets...</p></div>`;
    return;
  }
  if (currentUserPets.length === 0) {
    list.innerHTML = `<div class="ph-dash-empty"><p class="ph-dash-empty-title">No pets registered yet</p><p class="ph-dash-empty-text">Add a pet profile before booking an appointment.</p><a href="pets.html" class="ph-btn ph-btn-primary ph-btn-sm">Register a pet</a></div>`;
    return;
  }
  const selectedId = String(petSelect?.value || "");
  list.innerHTML = currentUserPets.map(pet => {
    const facts = [pet.species, pet.breed, Number.isFinite(Number(pet.age)) ? `${pet.age} years` : ""]
      .filter(Boolean).join(" · ");
    return `<button type="button" class="ph-pet-picker-option${String(pet.id) === selectedId ? " is-selected" : ""}" data-pet-picker-id="${escapeHtml(pet.id)}" aria-pressed="${String(pet.id) === selectedId}">
      <span class="ph-pet-picker-icon" aria-hidden="true"><i class="${String(pet.species).toLowerCase() === "cat" ? "ri-mickey-line" : "ri-bear-smile-line"}"></i></span>
      <span class="ph-pet-picker-copy"><strong>${escapeHtml(pet.name)}</strong><span>${escapeHtml(facts || "Species details not recorded")}</span></span>
      <i class="ri-check-line ph-pet-picker-check" aria-hidden="true"></i>
    </button>`;
  }).join("");
}

// "Request an appointment" on My Pets names the pet's existing profile (?pet=<id>). Only one of the owner's own loaded
// pets can be chosen this way (any other id is ignored), and the booking still uses that profile's id; no pet is created.
function applyRequestedPet() {
  const requested = new URLSearchParams(window.location.search).get("pet");
  const petSelect = getAppointmentPetSelect();
  if (!requested || !petSelect || petSelect.value || !getAppointmentPetById(requested)) return;
  petSelect.value = String(requested).trim();
  petSelect.dispatchEvent(new Event("change"));
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
  renderPetPicker();

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
    applyRequestedPet();
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
    loadedAppointments = [];
    setAppointmentListSummary("");
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
    <div class="ph-dash-error" role="alert">
      <p class="ph-dash-error-title">Unable to load appointments</p>
      <p class="ph-dash-error-text">${escapeHtml(message || "Please refresh the page or try again later.")}</p>
    </div>
  `;
}

/**
 * Display appointments list: keeps the server's list and shows it with the current filters
 */
function displayAppointments(appointments) {
  loadedAppointments = Array.isArray(appointments) ? appointments : [];
  renderAppointmentList();
}

// Upcoming: Pending or Approved and not over yet (start + saved duration, browser-local time like the times shown);
// everything else (Completed, Cancelled, or a date that has passed) is History
function isUpcomingAppointment(appointment, now = new Date()) {
  if (!UPCOMING_APPOINTMENT_STATUSES.includes(getAppointmentStatusLabel(appointment?.status))) return false;
  const startTime = parseAppointmentDateTime(getAppointmentRecordDateValue(appointment?.appointment_date), appointment?.appointment_time);
  if (!startTime) return false;
  const durationMinutes = getStoredAppointmentDurationMinutes(appointment);
  const endTime = Number.isFinite(durationMinutes) ? new Date(startTime.getTime() + durationMinutes * 60000) : startTime;
  return endTime > now;
}

function getAppointmentStartMs(appointment) {
  const startTime = parseAppointmentDateTime(getAppointmentRecordDateValue(appointment?.appointment_date), appointment?.appointment_time);
  return startTime ? startTime.getTime() : 0;
}

function isOwnerCancellationAllowed(appointment, now = Date.now()) {
  return getOwnerCancellationState(appointment, now).canCancel;
}

function formatClinicDateTime(timestamp) {
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CLINIC_TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(timestamp));
}

function getOwnerCancellationState(appointment, now = Date.now()) {
  const status = getAppointmentStatusLabel(appointment?.status);
  if (!['Pending', 'Approved'].includes(status)) {
    return { canCancel: false, reason: `Cancellation is unavailable because this appointment is ${status.toLowerCase()}.` };
  }

  const startMs = getAppointmentStartMs(appointment);
  if (!startMs) return { canCancel: false, reason: 'Cancellation is unavailable because the scheduled clinic time could not be verified. Contact the clinic.' };

  const deadlineMs = startMs - APPOINTMENT_CANCEL_CUTOFF_MS;
  if (now > deadlineMs && now < startMs) {
    return { canCancel: false, deadlineMs, reason: `The two-hour cancellation deadline passed at ${formatClinicDateTime(deadlineMs)} (${CLINIC_TIME_ZONE}). Contact the clinic for help.` };
  }
  if (now >= startMs) {
    return { canCancel: false, deadlineMs, reason: 'The appointment has started or passed, so owner cancellation is unavailable. Contact the clinic for help.' };
  }

  return { canCancel: true, deadlineMs };
}

function setAppointmentListSummary(text) {
  const summary = document.getElementById("appointmentListSummary");
  if (summary) summary.textContent = text;
}

function renderAppointmentList() {
  const container = document.getElementById("appointmentsList");
  if (!container) return;

  if (loadedAppointments.length === 0) {
    setAppointmentListSummary("");
    container.innerHTML = `
      <div class="ph-dash-empty">
        <p class="ph-dash-empty-title">No appointments yet</p>
        <p class="ph-dash-empty-text">Appointments you book will appear here with their clinic status.</p>
      </div>
    `;
    return;
  }

  const now = new Date();
  const upcoming = loadedAppointments.filter(apt => isUpcomingAppointment(apt, now));
  const history = loadedAppointments.filter(apt => !isUpcomingAppointment(apt, now));
  const byWhen = { upcoming, history, all: loadedAppointments }[appointmentListFilter.when] || loadedAppointments;
  const shown = byWhen
    .filter(apt => appointmentListFilter.status === "all" || getAppointmentStatusLabel(apt.status) === appointmentListFilter.status)
    // Upcoming: soonest first; History and All keep the server's order (newest first)
    .sort((a, b) => (appointmentListFilter.when === "upcoming" ? getAppointmentStartMs(a) - getAppointmentStartMs(b) : 0));

  setAppointmentListSummary(`Showing ${shown.length} of ${loadedAppointments.length} appointment${loadedAppointments.length === 1 ? "" : "s"} (${upcoming.length} upcoming, ${history.length} in history).`);

  if (shown.length === 0) {
    container.innerHTML = `
      <div class="ph-dash-empty">
        <p class="ph-dash-empty-title">No appointments match these filters</p>
        <p class="ph-dash-empty-text">Choose History or All, or another status, to see your other appointments.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = shown.map(apt => getAppointmentCardHtml(apt, isUpcomingAppointment(apt, now))).join("");
}

function getAppointmentCardHtml(apt, isUpcoming) {
  const handledBy = getHandledByLabel(apt);
  const status = getAppointmentStatusLabel(apt.status);
  const cancellation = getOwnerCancellationState(apt);
  const fact = (label, value) => `<div><dt>${escapeHtml(label)}</dt> <dd>${escapeHtml(value)}</dd></div>`;
  return `
    <article class="ph-dash-card">
      <div class="ph-dash-card-head">
        <div>
          <p class="ph-dash-card-title">${escapeHtml(apt.pet_name || "N/A")} &middot; ${escapeHtml(apt.service_type || "N/A")}</p>
          <p class="ph-dash-note">Reference ${escapeHtml(getAppointmentReference(apt))}</p>
        </div>
        <span class="${getStatusClass(status)} px-3 py-1 text-xs">${escapeHtml(status)}</span>
      </div>
      <dl class="ph-dash-facts ph-dash-facts-3">
        ${fact("Date", formatAppointmentDateDisplay(apt.appointment_date))}
        ${fact("Time range", getAppointmentTimeRangeDisplay(apt))}
        ${fact("Duration", getAppointmentDisplayDuration(apt))}
        ${handledBy ? fact("Handled by", handledBy) : ""}
      </dl>
      <p class="ph-dash-next"><i class="ri-arrow-right-circle-line" aria-hidden="true"></i><span>${escapeHtml(getAppointmentNextStep(status, isUpcoming))}</span></p>
      ${cancellation.canCancel ? `<div class="ph-dash-card-actions"><button type="button" class="ph-btn ph-btn-secondary ph-btn-sm" data-appointment-cancel="${escapeHtml(apt.id)}"><i class="ri-close-circle-line" aria-hidden="true"></i>Cancel appointment</button><span class="ph-dash-note">Cancel by ${escapeHtml(formatClinicDateTime(cancellation.deadlineMs))} (${CLINIC_TIME_ZONE})</span></div>` : `<p class="ph-dash-note" role="status">${escapeHtml(cancellation.reason)}</p>`}
    </article>
  `;
}

// What the owner can expect or do next, from the appointment's status as the server reports it
function getAppointmentNextStep(status, isUpcoming) {
  if (status === "Pending" && isUpcoming) return "Waiting for the clinic to approve this request. You'll be emailed when it is approved or cancelled.";
  if (status === "Approved" && isUpcoming) return "Approved by the clinic for the date and time shown.";
  if (status === "Pending" || status === "Approved") return "This date has passed and the clinic has not updated the status yet.";
  if (status === "Completed") return "Completed. Any official record the clinic adds appears under Pet Health & AI Assistant.";
  if (status === "Cancelled") return "Cancelled. Book again when online booking is open, or contact the clinic.";
  return "Contact the clinic if you have questions about this appointment.";
}

function setupAppointmentFilters() {
  document.querySelectorAll("[data-appointment-when]").forEach(button => {
    button.addEventListener("click", () => {
      appointmentListFilter.when = button.dataset.appointmentWhen;
      document.querySelectorAll("[data-appointment-when]").forEach(other => {
        other.setAttribute("aria-pressed", String(other === button));
      });
      renderAppointmentList();
    });
  });
  document.getElementById("appointmentStatusFilter")?.addEventListener("change", event => {
    appointmentListFilter.status = event.target.value;
    renderAppointmentList();
  });
  document.getElementById("appointmentsList")?.addEventListener("click", handleAppointmentCancellationClick);
}

async function handleAppointmentCancellationClick(event) {
  const button = event.target.closest("[data-appointment-cancel]");
  if (!button) return;
  const appointmentId = String(button.dataset.appointmentCancel || "");
  if (!appointmentId || appointmentCancellationInProgress.has(appointmentId)) return;
  const appointment = loadedAppointments.find(item => String(item.id) === appointmentId);
  if (!isOwnerCancellationAllowed(appointment)) {
    showAppointmentActionFeedback("The cancellation window has closed. Contact the clinic for help.", "error");
    renderAppointmentList();
    return;
  }
  const confirmed = window.confirm("Cancel this appointment? This will change its status to Cancelled.");
  if (!confirmed) return;

  appointmentCancellationInProgress.add(appointmentId);
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const response = await fetch(`${window.API_BASE_URL}/appointments/cancel/${encodeURIComponent(appointmentId)}`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      const error = new Error(data.error || "Could not cancel this appointment.");
      error.status = response.status;
      throw error;
    }
    showAppointmentActionFeedback(data.already_cancelled ? "This appointment was already cancelled." : "Appointment cancelled.", "success");
    await loadAppointments(currentUser.id);
  } catch (error) {
    showAppointmentActionFeedback(error.message || "Could not cancel this appointment.", "error");
    if (error.status === 409) await loadAppointments(currentUser.id);
    else button.disabled = false;
  } finally {
    appointmentCancellationInProgress.delete(appointmentId);
    button.removeAttribute("aria-busy");
  }
}

function showAppointmentActionFeedback(message, type) {
  const container = document.getElementById("appointmentActionFeedback");
  if (!container) return;
  container.textContent = message || "";
  container.className = message
    ? `mb-3 rounded-lg p-3 text-sm ${type === "error" ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"}`
    : "mb-3";
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
        service_id: details.serviceId,
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
      bookingError.status = response.status;
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
    // A 409 without a suggested time means the service itself changed (e.g. the clinic switched it off after this
    // page loaded): reload the list so it no longer offers what cannot be booked
    if (error?.status === 409 && !error?.suggestedTime) await loadServiceCatalog();
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

    const bookingDetails = {
      petId: selectedPetId,
      petName,
      serviceId: window.AppointmentDurations.getServiceId(serviceType),
      serviceType,
      appointmentDate,
      appointmentTime
    };

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
