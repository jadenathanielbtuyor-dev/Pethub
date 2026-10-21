// PetHub Pet Owner Dashboard: My Pets (pages/user/pets.html)
//
// Section 2 of the Pet Owner Dashboard. Only the signed-in owner's pets are ever requested: every call sends the
// owner's user_id with the session token, and backend/middleware/requireAuth.js answers 403 if they do not match.
// - List:     GET /pets/userPets?user_id=        -> pets (id, name, species, breed, age, created_at, medical record
//                                                   count, latest_weight from an official record or null)
// - Register: POST /pets/create                  -> the server re-validates (name and species required, Dog or Cat
//                                                   only, age a whole number from 1 to 25). A likely duplicate of one
//                                                   of the owner's own profiles is answered 409 POSSIBLE_DUPLICATE_PET
//                                                   with those profiles and nothing is saved: the owner opens one, or
//                                                   confirms a different pet (confirm_not_duplicate: true). Never merged.
// - Use an existing pet: picks one of the loaded profiles to open, or to request an appointment with its existing id
//                                                   (appointments.html?pet=<id>); nothing is created.
// - Edit:     PUT /pets/update/:id               -> only the changed fields; the same checks, including the duplicate one
// - History:  GET /pets/history/:id?user_id=     -> the pet's appointments (linked by pet_id) and official medical
//                                                   records, newest first, and the latest recorded weight; read-only
// - Delete:   DELETE /pets/delete/:id?user_id=   -> offered only while the history is empty, after a second click; the
//                                                   server refuses (409 PET_HAS_HISTORY) if anything points to the pet
// Medical records are created by clinic administrators only (the owner route POST /pets/medical-records/create always
// answers 403), so nothing here can add or change one. Success messages appear only after the server has confirmed
// the change.

// Module-level user variable - matches appointments.js pattern
let currentUser = null;
let currentPets = [];
let petsLoaded = false;
let petsLoadError = '';
let openPetId = '';
let petSubmitInProgress = false;
let petEditInProgress = false;
let petEditing = false;
// The open pet's history (GET /pets/history/:id): { petId, status: 'loading' | 'loaded' | 'error', data, error }
let petHistory = { petId: '', status: 'loading', data: null, error: '' };
let petHistoryRequestId = 0;
// The new-pet details waiting for the owner's answer to a possible duplicate
let pendingNewPet = null;
// The changes waiting for the owner's answer to a possible duplicate while editing
let pendingPetChanges = null;

const PET_FIELD_IDS = {
  create: { name: 'petName', species: 'petType', breed: 'petBreed', age: 'petAge' },
  edit: { name: 'petEditName', species: 'petEditSpecies', breed: 'petEditBreed', age: 'petEditAge' }
};
const PET_NAME_MAX_LENGTH = 50;
const PET_BREED_MAX_LENGTH = 50;
const PET_SPECIES = ['Dog', 'Cat'];
const POSSIBLE_DUPLICATE_PET_CODE = 'POSSIBLE_DUPLICATE_PET';

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  initializePets();
});

/**
 * Initialize pets feature
 */
async function initializePets() {
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

  // Validate user has valid id
  if (!user.id || user.id === '0') {
    console.error('Invalid user ID. Please log in again.');
    redirectToLogin();
    return;
  }

  currentUser = user;

  // Bind the forms before loading data so an early submit is handled instead of reloading the page.
  setupFormHandler();
  setupAddModeChoice();
  setupPetListActions();
  setupPetDetailActions();
  renderExistingPetChooser();

  await loadPets(currentUser.id);

  // A link such as pets.html?pet=<id> (from the Overview) opens that pet once its profile has loaded
  const requestedPet = new URLSearchParams(window.location.search).get('pet');
  if (requestedPet && getPetById(requestedPet)) openPetDetail(requestedPet, { focus: true });
}

// GET/POST/PUT/DELETE an owner route; resolves to { ok, status, data } (data {} when the body is not JSON)
async function requestPetsApi(path, options = {}) {
  const response = await fetch(`${window.API_BASE_URL}${path}`, options);
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

function getOwnerQuery() {
  return `user_id=${encodeURIComponent(currentUser.id)}`;
}

/**
 * Load user pets from backend
 */
async function loadPets(userId) {
  const container = document.getElementById('petsList');
  if (container) {
    container.innerHTML = getPetsLoadingHtml();
  }

  try {
    const { ok, status, data } = await requestPetsApi(`/pets/userPets?user_id=${encodeURIComponent(userId)}`);

    if (!ok) {
      throw new Error(data.error || `Failed to load pets (${status})`);
    }

    currentPets = Array.isArray(data.pets) ? data.pets : [];
    petsLoaded = true;
    petsLoadError = '';
    displayPetsList(currentPets);
    if (openPetId) {
      if (getPetById(openPetId)) renderPetDetail(openPetId);
      else closePetDetail();
    }
  } catch (error) {
    console.error('Error loading pets:', error);
    currentPets = [];
    petsLoaded = true;
    petsLoadError = error.message || 'Please refresh the page or try again later.';
    if (container) {
      container.innerHTML = getPetsErrorHtml(error.message);
    }
  } finally {
    renderExistingPetChooser();
  }
}

function getPetsLoadingHtml() {
  return `
    <div class="dashboard-loading-state" role="status" aria-live="polite">
      <div class="dashboard-loading-spinner" aria-hidden="true"></div>
      <div>
        <p class="dashboard-loading-title">Loading pets...</p>
        <p class="dashboard-loading-copy">Fetching the latest PetHub records.</p>
      </div>
    </div>
  `;
}

function getPetsErrorHtml(message) {
  return `
    <div class="ph-dash-error" role="alert">
      <p class="ph-dash-error-title">Unable to load pets</p>
      <p class="ph-dash-error-text">${escapeHtml(message || 'Please refresh the page or try again later.')}</p>
    </div>
  `;
}

function getPetById(petId) {
  const id = String(petId || '').trim();
  return id ? currentPets.find(pet => String(pet.id) === id) || null : null;
}

function hasPetValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function getPetAgeText(pet) {
  return hasPetValue(pet.age) ? `${pet.age} year${Number(pet.age) === 1 ? '' : 's'}` : 'Not recorded';
}

function getSpeciesBadgeHtml(species) {
  const value = String(species || '').trim();
  const modifier = value.toLowerCase() === 'dog' ? ' ph-badge-dog' : value.toLowerCase() === 'cat' ? ' ph-badge-cat' : '';
  return `<span class="ph-badge${modifier}">${escapeHtml(value || 'Species not recorded')}</span>`;
}

function getBookingHref(petId) {
  return `appointments.html?pet=${encodeURIComponent(String(petId))}`;
}

// The weight from the newest official record that has one (the server's latest_weight), never an estimate
function getLatestWeightText(latestWeight, { withDate = false } = {}) {
  if (!latestWeight || !Number.isFinite(Number(latestWeight.value))) return 'No weight recorded yet';
  const weight = `${Number(latestWeight.value)} ${latestWeight.unit || 'kg'}`;
  if (!withDate) return weight;
  return latestWeight.record_date ? `${weight}, recorded ${formatDate(latestWeight.record_date)}` : weight;
}

/**
 * Display pets list
 */
function displayPetsList(pets) {
  const container = document.getElementById('petsList');
  if (!container) return;

  if (!pets || pets.length === 0) {
    container.innerHTML = `
      <div class="ph-dash-empty">
        <p class="ph-dash-empty-title">No pets yet</p>
        <p class="ph-dash-empty-text">Register your first pet with the Add a pet form.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = pets.map(pet => {
    const id = escapeHtml(String(pet.id || ''));
    const name = escapeHtml(pet.name || 'Pet');
    const recordCount = Number(pet.medical_record_count) || 0;
    return `
      <article class="ph-dash-card" aria-labelledby="pet-${id}-name">
        <div class="ph-dash-card-head">
          <div>
            <p id="pet-${id}-name" class="ph-dash-card-title">${name}</p>
            <div class="ph-badges mt-1">
              ${getSpeciesBadgeHtml(pet.species)}
              <span class="ph-badge">${recordCount} medical record${recordCount === 1 ? '' : 's'}</span>
            </div>
          </div>
        </div>
        <dl class="ph-dash-facts ph-dash-facts-3">
          <div><dt>Breed</dt> <dd>${escapeHtml(pet.breed || 'Not recorded')}</dd></div>
          <div><dt>Age</dt> <dd>${escapeHtml(getPetAgeText(pet))}</dd></div>
          <div><dt>Latest weight</dt> <dd>${escapeHtml(getLatestWeightText(pet.latest_weight))}</dd></div>
        </dl>
        <div class="ph-dash-card-actions">
          <button type="button" class="ph-btn ph-btn-secondary ph-btn-sm" data-pet-view="${id}" aria-controls="petDetailPanel">
            <i class="ri-file-list-3-line" aria-hidden="true"></i>View details<span class="sr-only"> for ${name}</span>
          </button>
          <a href="${escapeHtml(getBookingHref(pet.id))}" class="ph-btn ph-btn-ghost ph-btn-sm">
            <i class="ri-calendar-check-line" aria-hidden="true"></i>Request an appointment<span class="sr-only"> for ${name}</span>
          </a>
        </div>
      </article>
    `;
  }).join('');
}

// "View details" on the pet cards (one listener for the whole list)
function setupPetListActions() {
  const container = document.getElementById('petsList');
  if (container) {
    container.addEventListener('click', event => {
      const viewButton = event.target.closest('[data-pet-view]');
      if (viewButton) openPetDetail(viewButton.dataset.petView, { focus: true });
    });
  }

  document.getElementById('petDetailClose')?.addEventListener('click', () => {
    const petId = openPetId;
    closePetDetail();
    document.querySelector(`[data-pet-view="${CSS.escape(petId)}"]`)?.focus();
  });
}

// ==================== ADD A PET: REGISTER A NEW PET OR USE AN EXISTING ONE ====================

function setupAddModeChoice() {
  document.querySelectorAll('[data-pet-mode]').forEach(button => {
    button.addEventListener('click', () => setAddPetMode(button.dataset.petMode));
  });

  const chooser = document.getElementById('existingPetChooser');
  chooser?.addEventListener('change', event => {
    if (event.target.id === 'existingPetSelect') updateExistingPetActions();
  });
  chooser?.addEventListener('click', event => {
    const petId = document.getElementById('existingPetSelect')?.value || '';
    if (!getPetById(petId)) return;
    if (event.target.closest('#existingPetOpen')) openPetDetail(petId, { focus: true });
    else if (event.target.closest('#existingPetBook')) window.location.href = getBookingHref(petId);
  });
}

function setAddPetMode(mode) {
  const useExisting = mode === 'existing';
  document.querySelectorAll('[data-pet-mode]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.petMode === (useExisting ? 'existing' : 'new')));
  });
  const newPanel = document.getElementById('petNewPanel');
  const existingPanel = document.getElementById('petExistingPanel');
  if (newPanel) newPanel.hidden = useExisting;
  if (existingPanel) existingPanel.hidden = !useExisting;
  if (useExisting) renderExistingPetChooser();
}

// The owner's registered pets to choose from; only profiles loaded from the server can be chosen
function renderExistingPetChooser() {
  const chooser = document.getElementById('existingPetChooser');
  if (!chooser) return;

  if (!petsLoaded) {
    chooser.innerHTML = '<p class="ph-dash-note" role="status">Loading your pets...</p>';
    return;
  }
  if (petsLoadError) {
    chooser.innerHTML = `
      <div class="ph-dash-error" role="alert">
        <p class="ph-dash-error-title">Unable to load your pets</p>
        <p class="ph-dash-error-text">${escapeHtml(petsLoadError)}</p>
      </div>
    `;
    return;
  }
  if (currentPets.length === 0) {
    chooser.innerHTML = `
      <div class="ph-dash-empty">
        <p class="ph-dash-empty-title">No registered pets yet</p>
        <p class="ph-dash-empty-text">Choose Register a new pet to add your first one.</p>
      </div>
    `;
    return;
  }

  const previous = document.getElementById('existingPetSelect')?.value || '';
  chooser.innerHTML = `
    <div class="ph-field">
      <label for="existingPetSelect" class="ph-label">Your registered pets</label>
      <select id="existingPetSelect" class="ph-input">
        <option value="">Select a pet</option>
        ${currentPets.map(pet => `<option value="${escapeHtml(String(pet.id))}">${escapeHtml(getPetOptionLabel(pet))}</option>`).join('')}
      </select>
    </div>
    <div class="ph-dash-card-actions">
      <button type="button" id="existingPetOpen" class="ph-btn ph-btn-secondary ph-btn-sm" disabled><i class="ri-file-list-3-line" aria-hidden="true"></i>Open profile</button>
      <button type="button" id="existingPetBook" class="ph-btn ph-btn-ghost ph-btn-sm" disabled><i class="ri-calendar-check-line" aria-hidden="true"></i>Request an appointment</button>
    </div>
  `;
  const select = document.getElementById('existingPetSelect');
  if (select && getPetById(previous)) select.value = previous;
  updateExistingPetActions();
}

function getPetOptionLabel(pet) {
  return [pet.name || 'Pet', pet.species, pet.breed].filter(hasPetValue).join(' - ');
}

function updateExistingPetActions() {
  const chosen = Boolean(getPetById(document.getElementById('existingPetSelect')?.value));
  ['existingPetOpen', 'existingPetBook'].forEach(id => {
    const button = document.getElementById(id);
    if (button) button.disabled = !chosen;
  });
}

// ==================== ONE PET: PROFILE, HISTORY, EDIT AND DELETE ====================

function openPetDetail(petId, { focus = false } = {}) {
  if (!getPetById(petId)) return;
  const changed = String(petId) !== openPetId;
  openPetId = String(petId);
  if (changed) petEditing = false;
  renderPetDetail(openPetId);
  if (changed || petHistory.status === 'error') loadPetHistory(openPetId);
  const panel = document.getElementById('petDetailPanel');
  if (panel) panel.hidden = false;

  const url = new URL(window.location.href);
  url.searchParams.set('pet', openPetId);
  history.replaceState(null, '', url);

  if (focus) {
    panel?.scrollIntoView({ block: 'start' });
    document.getElementById('petDetailTitle')?.focus();
  }
}

function closePetDetail() {
  openPetId = '';
  petEditing = false;
  pendingPetChanges = null;
  petHistoryRequestId += 1;
  petHistory = { petId: '', status: 'loading', data: null, error: '' };
  const panel = document.getElementById('petDetailPanel');
  if (panel) panel.hidden = true;
  const url = new URL(window.location.href);
  url.searchParams.delete('pet');
  history.replaceState(null, '', url);
}

function renderPetDetail(petId) {
  const pet = getPetById(petId);
  const content = document.getElementById('petDetailContent');
  const name = document.getElementById('petDetailName');
  if (!pet || !content) return;
  if (name) name.textContent = pet.name || 'Pet details';

  const encodedId = encodeURIComponent(String(pet.id));
  content.innerHTML = `
    <div class="ph-dash-grid-side">
      <div>
        <h3 class="ph-dash-card-title">Pet profile</h3>
        <p class="ph-dash-note">Details you entered for this pet.</p>
        <dl class="ph-dash-facts">
          <div class="is-wide"><dt>PetHub profile ID</dt> <dd class="ph-pet-id">${escapeHtml(String(pet.id))}</dd></div>
          <div><dt>Name</dt> <dd>${escapeHtml(pet.name || 'Not recorded')}</dd></div>
          <div><dt>Species</dt> <dd>${escapeHtml(pet.species || 'Not recorded')}</dd></div>
          <div><dt>Breed</dt> <dd>${escapeHtml(pet.breed || 'Not recorded')}</dd></div>
          <div><dt>Age (as entered)</dt> <dd>${escapeHtml(getPetAgeText(pet))}</dd></div>
          <div><dt>Added</dt> <dd>${pet.created_at ? escapeHtml(formatDate(pet.created_at)) : 'Unknown'}</dd></div>
          <div><dt>Latest recorded weight</dt> <dd id="petDetailWeight">${escapeHtml(getLatestWeightText(pet.latest_weight, { withDate: true }))}</dd></div>
        </dl>
        <p class="ph-dash-note mt-2">Weight comes only from official records the clinic has added.</p>
        <div id="petEditRegion"></div>
        <div class="ph-dash-card-actions" id="petProfileActions">
          <button type="button" id="petEditOpen" class="ph-btn ph-btn-secondary ph-btn-sm"><i class="ri-edit-line" aria-hidden="true"></i>Edit profile</button>
          <a href="${getBookingHref(pet.id)}" class="ph-btn ph-btn-secondary ph-btn-sm"><i class="ri-calendar-check-line" aria-hidden="true"></i>Request an appointment</a>
          <a href="health.html?pet=${encodedId}" class="ph-btn ph-btn-ghost ph-btn-sm"><i class="ri-heart-pulse-line" aria-hidden="true"></i>Pet Health &amp; AI Assistant</a>
        </div>
      </div>
      <div>
        <h3 class="ph-dash-card-title">Veterinary history</h3>
        <p class="ph-dash-note">What PetHub has recorded for this profile, newest first. Visits to other clinics, or from before the pet was in PetHub, are not shown.</p>
        <div id="petHistory" class="mt-3"></div>
      </div>
    </div>
    <div id="petRemoveRegion" class="ph-pet-section"></div>
  `;

  if (petEditing) renderPetEditForm(pet);
  renderPetHistory();
}

// ---------- History: GET /pets/history/:id ----------

async function loadPetHistory(petId) {
  const requestId = ++petHistoryRequestId;
  petHistory = { petId, status: 'loading', data: null, error: '' };
  renderPetHistory();

  try {
    const { ok, status, data } = await requestPetsApi(`/pets/history/${encodeURIComponent(petId)}?${getOwnerQuery()}`);
    if (requestId !== petHistoryRequestId) return;
    if (!ok) throw new Error(data.error || `Failed to load this pet's history (${status})`);
    petHistory = { petId, status: 'loaded', data, error: '' };
  } catch (error) {
    if (requestId !== petHistoryRequestId) return;
    console.error('Error loading pet history:', error);
    petHistory = { petId, status: 'error', data: null, error: error.message || 'Please refresh the page or try again later.' };
  }
  renderPetHistory();
}

function renderPetHistory() {
  const container = document.getElementById('petHistory');
  const pet = getPetById(openPetId);
  if (!container || !pet) return;

  if (petHistory.petId !== openPetId || petHistory.status === 'loading') {
    container.innerHTML = `
      <div class="dashboard-loading-state" role="status" aria-live="polite">
        <div class="dashboard-loading-spinner" aria-hidden="true"></div>
        <div>
          <p class="dashboard-loading-title">Loading history...</p>
          <p class="dashboard-loading-copy">Fetching appointments and medical records.</p>
        </div>
      </div>
    `;
  } else if (petHistory.status === 'error') {
    container.innerHTML = `
      <div class="ph-dash-error" role="alert">
        <p class="ph-dash-error-title">Unable to load this pet's history</p>
        <p class="ph-dash-error-text">${escapeHtml(petHistory.error)}</p>
        <button type="button" class="ph-btn ph-btn-secondary ph-btn-sm mt-3" data-history-retry>Try again</button>
      </div>
    `;
  } else {
    const { appointments = [], medical_records: records = [], unlinked_appointment_count: unlinked } = petHistory.data || {};
    const petName = escapeHtml(pet.name || 'this pet');
    container.innerHTML = `
      <section class="ph-pet-history" aria-labelledby="petAppointmentHistoryTitle">
        <div class="ph-dash-card-head">
          <h4 id="petAppointmentHistoryTitle" class="ph-dash-card-title">Appointment history</h4>
          <span class="ph-badge">${appointments.length} appointment${appointments.length === 1 ? '' : 's'}</span>
        </div>
        <p class="ph-dash-note">Appointment requests booked for this profile and their current status. An appointment counts as a visit only once the clinic marks it Completed.</p>
        <div class="ph-dash-stack mt-3">
          ${appointments.length ? appointments.map(getHistoryAppointmentHtml).join('') : `
            <div class="ph-dash-empty">
              <p class="ph-dash-empty-title">No appointments yet</p>
              <p class="ph-dash-empty-text">No appointments have been booked in PetHub for ${petName}.</p>
            </div>
          `}
        </div>
        ${Number(unlinked) > 0 ? `<p class="ph-dash-note mt-3">${Number(unlinked)} older appointment${Number(unlinked) === 1 ? ' on your account is' : 's on your account are'} not linked to a pet profile, so ${Number(unlinked) === 1 ? 'it is' : 'they are'} not shown here. You can still find ${Number(unlinked) === 1 ? 'it' : 'them'} on the <a class="ph-dash-link" href="appointments.html">Appointments</a> page.</p>` : ''}
      </section>
      <section class="ph-pet-history" aria-labelledby="petMedicalHistoryTitle">
        <div class="ph-dash-card-head">
          <h4 id="petMedicalHistoryTitle" class="ph-dash-card-title">Official medical history</h4>
          <span class="ph-badge ph-badge-official"><i class="ri-shield-check-line" aria-hidden="true"></i>From the clinic</span>
        </div>
        <p class="ph-dash-note">Recorded by clinic staff. You can read these records; only the clinic can add or change them.</p>
        <div class="ph-dash-stack mt-3">
          ${records.length ? records.map(getMedicalRecordHtml).join('') : `
            <div class="ph-dash-empty">
              <p class="ph-dash-empty-title">No medical records yet</p>
              <p class="ph-dash-empty-text">No official records are available in PetHub for ${petName} yet. Records the clinic adds will appear here.</p>
            </div>
          `}
        </div>
      </section>
    `;
    // The history's weight is the server's newest; keep the profile in step with it
    const weight = document.getElementById('petDetailWeight');
    if (weight && petHistory.data) weight.textContent = getLatestWeightText(petHistory.data.latest_weight, { withDate: true });
  }

  renderPetRemoveRegion();
}

function getAppointmentStatusLabel(status) {
  if (!hasPetValue(status)) return 'Status not recorded';
  const labels = { pending: 'Pending', approved: 'Approved', completed: 'Completed', cancelled: 'Cancelled' };
  return labels[String(status).trim().toLowerCase()] || String(status).trim();
}

// Status badge colours (assets/css/input.css .ph-status-*), the same as the Appointments page
function getStatusClass(status) {
  const statusClasses = {
    Approved: 'ph-status ph-status-approved',
    Cancelled: 'ph-status ph-status-cancelled',
    Completed: 'ph-status ph-status-completed',
    Pending: 'ph-status ph-status-pending'
  };
  return statusClasses[status] || 'ph-status ph-status-other';
}

// Same short reference as the Appointments page (the stored appointment_reference is empty)
function getAppointmentReference(appointment) {
  const compactId = String(appointment?.id || '').replace(/[^A-Za-z0-9]/g, '');
  return compactId ? `PH-${compactId.slice(0, 8).toUpperCase()}` : 'N/A';
}

function formatClockTime(timeValue, extraMinutes = 0) {
  const match = String(timeValue || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return '';
  const time = new Date(2000, 0, 1, Number(match[1]), Number(match[2]) + extraMinutes);
  return time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function getAppointmentTimeText(appointment) {
  const start = formatClockTime(appointment.appointment_time);
  if (!start) return 'Not recorded';
  const duration = Number(appointment.estimated_duration_minutes);
  return Number.isFinite(duration) && duration > 0 ? `${start} - ${formatClockTime(appointment.appointment_time, duration)}` : start;
}

function getHistoryAppointmentHtml(appointment) {
  const status = getAppointmentStatusLabel(appointment.status);
  const date = String(appointment.appointment_date || '').slice(0, 10);
  const handledBy = appointment.handled_by && appointment.handled_by_name ? appointment.handled_by_name : '';
  return `
    <article class="ph-dash-card">
      <div class="ph-dash-card-head">
        <div>
          <p class="ph-dash-card-title">${escapeHtml(appointment.service_type || 'Service not recorded')}</p>
          <p class="ph-dash-note">Appointment &middot; Reference ${escapeHtml(getAppointmentReference(appointment))}</p>
        </div>
        <span class="${getStatusClass(status)} px-3 py-1 text-xs">${escapeHtml(status)}</span>
      </div>
      <dl class="ph-dash-facts ph-dash-facts-3">
        <div><dt>Date</dt> <dd>${escapeHtml(date ? formatDate(date) : 'Not recorded')}</dd></div>
        <div><dt>Time</dt> <dd>${escapeHtml(getAppointmentTimeText(appointment))}</dd></div>
        <div><dt>Requested</dt> <dd>${escapeHtml(appointment.created_at ? formatDate(appointment.created_at) : 'Not recorded')}</dd></div>
        ${handledBy ? `<div><dt>Handled by</dt> <dd>${escapeHtml(handledBy)}</dd></div>` : ''}
      </dl>
    </article>
  `;
}

// ---------- Delete: only while the history is empty ----------

function renderPetRemoveRegion() {
  const region = document.getElementById('petRemoveRegion');
  const pet = getPetById(openPetId);
  if (!region || !pet) return;

  const name = escapeHtml(pet.name || 'This pet');
  const title = '<h3 class="ph-dash-card-title">Delete this profile</h3>';
  if (petHistory.petId !== openPetId || petHistory.status === 'loading') {
    region.innerHTML = '';
    return;
  }
  if (petHistory.status === 'error') {
    region.innerHTML = `${title}<p class="ph-dash-note">Deleting is unavailable until this pet's history has loaded.</p>`;
    return;
  }

  const appointments = (petHistory.data?.appointments || []).length;
  const records = (petHistory.data?.medical_records || []).length;
  if (appointments > 0 || records > 0) {
    const held = [
      appointments ? `${appointments} appointment${appointments === 1 ? '' : 's'}` : '',
      records ? `${records} official medical record${records === 1 ? '' : 's'}` : ''
    ].filter(Boolean).join(' and ');
    region.innerHTML = `
      ${title}
      <p class="ph-dash-note">${name}'s profile can't be deleted because PetHub holds ${held} for it. The profile is kept so that history stays linked to it. If a detail is wrong, use Edit profile. If the profile needs to be removed, <a class="ph-dash-link" href="../public/contact.html">contact the clinic</a>.</p>
    `;
    return;
  }

  region.innerHTML = `
    ${title}
    <p class="ph-dash-note">${name} has no appointments or official medical records in PetHub. Deleting removes this profile from your account and can't be undone.</p>
    <div id="petRemoveMessage" class="ph-dash-status mt-3"></div>
    <div class="ph-dash-card-actions">
      <button type="button" id="petDeleteButton" class="ph-btn ph-btn-ghost ph-btn-sm" data-pet-delete="${escapeHtml(String(pet.id))}">
        <i class="ri-delete-bin-line" aria-hidden="true"></i>Delete profile<span class="sr-only"> ${name}</span>
      </button>
    </div>
  `;
}

// Edit, retry, delete and the duplicate choices inside the details (one listener; the content is re-rendered)
function setupPetDetailActions() {
  const content = document.getElementById('petDetailContent');
  if (!content) return;

  content.addEventListener('click', event => {
    if (event.target.closest('#petEditOpen')) {
      petEditing = true;
      renderPetEditForm(getPetById(openPetId));
      document.getElementById('petEditName')?.focus();
      return;
    }
    if (event.target.closest('#petEditCancel')) {
      closePetEditForm({ focus: true });
      return;
    }
    if (event.target.closest('[data-history-retry]')) {
      loadPetHistory(openPetId);
      return;
    }
    const deleteButton = event.target.closest('[data-pet-delete]');
    if (deleteButton) {
      deletePetHandler(deleteButton, deleteButton.dataset.petDelete);
      return;
    }
    handleDuplicateChoice(event, 'edit');
  });

  content.addEventListener('submit', event => {
    if (event.target.id !== 'petEditForm') return;
    event.preventDefault();
    savePetEdits();
  });

  // A change to the details answers any open duplicate question
  content.addEventListener('input', event => {
    if (pendingPetChanges && event.target.closest('#petEditForm')) {
      pendingPetChanges = null;
      hidePetDuplicateNotice('edit');
    }
  });
}

/**
 * Delete pet handler
 */
async function deletePetHandler(button, petId) {
  if (button?.dataset?.loading === 'true') return;

  if (!requireSecondClick(button, {
    key: `delete-pet:${petId}`,
    message: 'Click again to delete this profile'
  })) {
    return;
  }

  const originalText = button?.textContent?.trim() || 'Delete profile';
  const message = document.getElementById('petRemoveMessage');

  try {
    if (button) {
      updateButtonState(button, true, 'Deleting...', originalText);
    }

    const { ok, data } = await requestPetsApi(`/pets/delete/${encodeURIComponent(petId)}?${getOwnerQuery()}`, {
      method: 'DELETE'
    });

    if (!ok) {
      const refusal = new Error(data.error || 'Could not delete pet.');
      refusal.hasHistory = data.code === 'PET_HAS_HISTORY';
      throw refusal;
    }

    closePetDetail();
    await loadPets(currentUser.id);
    if (typeof showSuccess === 'function') showSuccess('Pet profile deleted.');
    document.getElementById('petsListTitle')?.scrollIntoView({ block: 'nearest' });
  } catch (error) {
    console.error('Error deleting pet:', error);
    if (button) {
      updateButtonState(button, false, 'Deleting...', originalText);
    }
    if (message) displayMessage(message, error.message || 'Could not delete pet.', 'error');
    // The server found history this page had not loaded yet: show it
    if (error.hasHistory) loadPetHistory(petId);
  }
}

// ---------- Edit profile: PUT /pets/update/:id ----------

function getSpeciesOptionsHtml(selected) {
  const current = String(selected || '').trim();
  // A species saved before the Dog/Cat rule is kept as the current choice, so it is never changed silently
  const legacy = current && !PET_SPECIES.includes(current) ? `<option value="${escapeHtml(current)}">${escapeHtml(current)} (saved)</option>` : '';
  return `${legacy}${PET_SPECIES.map(species => `<option value="${species}">${species}</option>`).join('')}`;
}

function renderPetEditForm(pet) {
  const region = document.getElementById('petEditRegion');
  if (!region || !pet) return;
  document.getElementById('petEditOpen')?.setAttribute('hidden', '');

  const savedAgeAccepted = validateAge(pet.age).valid;
  region.innerHTML = `
    <form id="petEditForm" class="ph-form ph-pet-edit" novalidate aria-labelledby="petEditTitle">
      <h4 id="petEditTitle" class="ph-dash-card-title">Edit profile</h4>
      <div class="ph-field">
        <label for="petEditName" class="ph-label">Pet name<span class="ph-required" aria-hidden="true">*</span></label>
        <input type="text" id="petEditName" class="ph-input" maxlength="${PET_NAME_MAX_LENGTH}" required aria-describedby="petEditNameError" value="${escapeHtml(pet.name || '')}">
        <p id="petEditNameError" class="ph-field-error" hidden></p>
      </div>
      <div class="ph-field">
        <label for="petEditSpecies" class="ph-label">Species<span class="ph-required" aria-hidden="true">*</span></label>
        <select id="petEditSpecies" class="ph-input" required aria-describedby="petEditSpeciesError">${getSpeciesOptionsHtml(pet.species)}</select>
        <p id="petEditSpeciesError" class="ph-field-error" hidden></p>
      </div>
      <div class="ph-field">
        <label for="petEditBreed" class="ph-label">Breed</label>
        <input type="text" id="petEditBreed" class="ph-input" maxlength="${PET_BREED_MAX_LENGTH}" aria-describedby="petEditBreedError" value="${escapeHtml(pet.breed || '')}">
        <p id="petEditBreedError" class="ph-field-error" hidden></p>
      </div>
      <div class="ph-field">
        <label for="petEditAge" class="ph-label">Age (years)<span class="ph-required" aria-hidden="true">*</span></label>
        <input type="number" id="petEditAge" class="ph-input" min="1" max="25" step="1" inputmode="numeric" required aria-describedby="petEditAgeHelp petEditAgeError" value="${escapeHtml(hasPetValue(pet.age) ? String(pet.age) : '')}">
        <p id="petEditAgeHelp" class="ph-help">${savedAgeAccepted
          ? 'Whole years from 1 to 25.'
          : 'Whole years from 1 to 25. The saved age is kept until you change it, but it must be updated if you change the species.'}</p>
        <p id="petEditAgeError" class="ph-field-error" hidden></p>
      </div>
      <div id="petEditMessage" class="ph-dash-status"></div>
      <div id="petEditDuplicateNotice" class="ph-pet-notice" tabindex="-1" hidden></div>
      <div class="ph-dash-card-actions">
        <button type="submit" class="ph-btn ph-btn-primary ph-btn-sm"><i class="ri-save-line" aria-hidden="true"></i>Save changes</button>
        <button type="button" id="petEditCancel" class="ph-btn ph-btn-secondary ph-btn-sm">Cancel</button>
      </div>
    </form>
  `;
  const species = document.getElementById('petEditSpecies');
  if (species) species.value = String(pet.species || '').trim();
}

function closePetEditForm({ focus = false } = {}) {
  petEditing = false;
  pendingPetChanges = null;
  const region = document.getElementById('petEditRegion');
  if (region) region.innerHTML = '';
  const openButton = document.getElementById('petEditOpen');
  if (openButton) {
    openButton.removeAttribute('hidden');
    if (focus) openButton.focus();
  }
}

// Only what the owner changed is sent; an unchanged saved value (even one this form would refuse) is left alone
function getPetEditChanges(pet) {
  const values = readPetFormValues('edit');
  const changes = {};
  if (values.name !== String(pet.name || '').trim().replace(/\s+/g, ' ')) changes.name = values.name;
  if (values.species !== String(pet.species || '').trim()) changes.species = values.species;
  if (values.breed !== String(pet.breed || '').trim()) changes.breed = values.breed || null;
  if (values.ageBadInput || values.age !== (hasPetValue(pet.age) ? String(pet.age) : '')) changes.age = values.age;
  return { values, changes };
}

async function savePetEdits({ confirmNotDuplicate = false } = {}) {
  const pet = getPetById(openPetId);
  const form = document.getElementById('petEditForm');
  const message = document.getElementById('petEditMessage');
  if (!pet || !form || petEditInProgress) return;

  hidePetDuplicateNotice('edit');
  if (message) clearMessage(message);

  const { values, changes } = confirmNotDuplicate && pendingPetChanges
    ? { values: readPetFormValues('edit'), changes: pendingPetChanges }
    : getPetEditChanges(pet);

  const errors = getPetFieldErrors(values, {
    fields: Object.keys(changes),
    // A new species needs an age this form accepts, even if the saved age was not changed
    requireAge: changes.species !== undefined
  });
  showPetFieldErrors('edit', errors);
  if (Object.keys(errors).length > 0) {
    focusFirstPetFieldError('edit', errors);
    return;
  }
  if (Object.keys(changes).length === 0) {
    if (message) displayMessage(message, 'Nothing has changed yet. Change a detail, or choose Cancel.', 'error');
    return;
  }

  const body = { user_id: currentUser.id, ...changes };
  if (body.age !== undefined) body.age = Number(body.age);
  if (confirmNotDuplicate) body.confirm_not_duplicate = true;

  petEditInProgress = true;
  setFormSubmitting(form, true, 'Saving...', 'Save changes');
  try {
    const { ok, data } = await requestPetsApi(`/pets/update/${encodeURIComponent(pet.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!ok && data.code === POSSIBLE_DUPLICATE_PET_CODE) {
      pendingPetChanges = changes;
      showPetDuplicateNotice('edit', data.possible_duplicates);
      return;
    }
    if (!ok) {
      if (data.field) showPetFieldErrors('edit', { [data.field]: data.error });
      throw new Error(data.error || 'Could not save the changes.');
    }

    pendingPetChanges = null;
    petEditing = false;
    await loadPets(currentUser.id);
    if (typeof showSuccess === 'function') showSuccess('Pet profile updated.');
    document.getElementById('petEditOpen')?.focus();
  } catch (error) {
    console.error('Error updating pet:', error);
    if (message) displayMessage(message, error.message || 'Could not save the changes.', 'error');
  } finally {
    petEditInProgress = false;
    if (document.body.contains(form)) setFormSubmitting(form, false, 'Saving...', 'Save changes');
  }
}

// ==================== FORM VALUES, CHECKS AND FIELD MESSAGES (register and edit) ====================

function readPetFormValues(kind) {
  const ids = PET_FIELD_IDS[kind];
  const ageInput = document.getElementById(ids.age);
  return {
    name: (document.getElementById(ids.name)?.value || '').trim().replace(/\s+/g, ' '),
    species: (document.getElementById(ids.species)?.value || '').trim(),
    breed: (document.getElementById(ids.breed)?.value || '').trim(),
    // A number field the browser cannot read ("e", "--") reports '' with validity.badInput
    age: (ageInput?.value || '').trim(),
    ageBadInput: Boolean(ageInput?.validity?.badInput)
  };
}

// fields: which fields to check (all by default); requireAge also checks the age when it is not in fields
function getPetFieldErrors(values, { fields = ['name', 'species', 'breed', 'age'], requireAge = false } = {}) {
  const errors = {};
  if (fields.includes('name')) {
    if (!values.name) errors.name = 'Enter the pet\'s name.';
    else if (values.name.length > PET_NAME_MAX_LENGTH) errors.name = `Pet name must be ${PET_NAME_MAX_LENGTH} characters or fewer.`;
  }
  if (fields.includes('species')) {
    if (!values.species) errors.species = 'Choose the pet\'s species.';
    else if (!PET_SPECIES.includes(values.species)) errors.species = 'The clinic cares for dogs and cats only. Choose Dog or Cat.';
  }
  if (fields.includes('breed') && values.breed.length > PET_BREED_MAX_LENGTH) {
    errors.breed = `Breed must be ${PET_BREED_MAX_LENGTH} characters or fewer.`;
  }
  if (fields.includes('age') || requireAge) {
    const ageValidation = values.ageBadInput ? validateAge('not a number') : validateAge(values.age);
    if (!ageValidation.valid) errors.age = ageValidation.error;
  }
  return errors;
}

function setPetFieldError(inputId, message) {
  const input = document.getElementById(inputId);
  const error = document.getElementById(`${inputId}Error`);
  if (input) {
    input.classList.toggle('is-invalid', Boolean(message));
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
  if (error) {
    error.textContent = message || '';
    error.hidden = !message;
  }
}

function showPetFieldErrors(kind, errors) {
  Object.entries(PET_FIELD_IDS[kind]).forEach(([field, inputId]) => setPetFieldError(inputId, errors[field] || ''));
}

function focusFirstPetFieldError(kind, errors) {
  const first = ['name', 'species', 'breed', 'age'].find(field => errors[field]);
  if (first) document.getElementById(PET_FIELD_IDS[kind][first])?.focus();
}

// ==================== POSSIBLE DUPLICATE: the owner's own matching profiles, never merged ====================

function getDuplicateNotice(kind) {
  return document.getElementById(kind === 'edit' ? 'petEditDuplicateNotice' : 'petDuplicateNotice');
}

function hidePetDuplicateNotice(kind) {
  const notice = getDuplicateNotice(kind);
  if (!notice) return;
  notice.hidden = true;
  notice.innerHTML = '';
}

function getDuplicateDetails(pet) {
  return [
    pet.species,
    pet.breed,
    hasPetValue(pet.age) ? getPetAgeText(pet) : '',
    pet.created_at ? `added ${formatDate(pet.created_at)}` : ''
  ].filter(hasPetValue).join(' · ');
}

function showPetDuplicateNotice(kind, duplicates) {
  const notice = getDuplicateNotice(kind);
  const matches = (Array.isArray(duplicates) ? duplicates : []).filter(pet => pet && pet.id);
  if (!notice) return;

  const confirmLabel = kind === 'edit' ? 'It\'s a different pet: save changes' : 'It\'s a different pet: add it';
  const dismissLabel = kind === 'edit' ? 'Keep editing' : 'Change the details';
  notice.innerHTML = `
    <p id="${kind}DuplicateTitle" class="ph-pet-notice-title"><i class="ri-error-warning-line" aria-hidden="true"></i>This looks like a pet you already registered</p>
    <p class="ph-pet-notice-text">Your account already has ${matches.length === 1 ? 'a profile' : 'profiles'} with the same name, species and matching details. Two pets can share a name, so nothing has been saved or merged: choose what to do.</p>
    <ul class="ph-dash-stack mt-3" aria-label="Matching profiles">
      ${matches.map(pet => `
        <li class="ph-dash-card">
          <p class="ph-dash-card-title">${escapeHtml(pet.name || 'Pet')}</p>
          <p class="ph-dash-note">${escapeHtml(getDuplicateDetails(pet))}</p>
          <p class="ph-dash-note">PetHub profile ID <span class="ph-pet-id">${escapeHtml(String(pet.id))}</span></p>
          <div class="ph-dash-card-actions">
            <button type="button" class="ph-btn ph-btn-secondary ph-btn-sm" data-duplicate-open="${escapeHtml(String(pet.id))}">Open this profile</button>
            <a href="${escapeHtml(getBookingHref(pet.id))}" class="ph-btn ph-btn-ghost ph-btn-sm">Request an appointment<span class="sr-only"> for ${escapeHtml(pet.name || 'this pet')}</span></a>
          </div>
        </li>
      `).join('')}
    </ul>
    <div class="ph-dash-card-actions">
      <button type="button" class="ph-btn ph-btn-secondary ph-btn-sm" data-duplicate-confirm>${confirmLabel}</button>
      <button type="button" class="ph-btn ph-btn-ghost ph-btn-sm" data-duplicate-dismiss>${dismissLabel}</button>
    </div>
  `;
  notice.setAttribute('role', 'region');
  notice.setAttribute('aria-labelledby', `${kind}DuplicateTitle`);
  notice.hidden = false;
  notice.focus();
}

// The buttons inside a duplicate notice: open the existing profile, confirm a different pet, or go back to the form
function handleDuplicateChoice(event, kind) {
  const notice = getDuplicateNotice(kind);
  if (!notice || !notice.contains(event.target)) return;

  const openButton = event.target.closest('[data-duplicate-open]');
  if (openButton) {
    const petId = openButton.dataset.duplicateOpen;
    if (kind === 'create') {
      pendingNewPet = null;
      hidePetDuplicateNotice('create');
      resetPetForm();
      showPetFeedback(document.getElementById('petSuccess'), 'No new profile was added. Showing the profile you already have.', 'success');
    } else {
      closePetEditForm();
    }
    openPetDetail(petId, { focus: true });
    return;
  }
  if (event.target.closest('[data-duplicate-confirm]')) {
    if (kind === 'create') submitNewPet({ confirmNotDuplicate: true });
    else savePetEdits({ confirmNotDuplicate: true });
    return;
  }
  if (event.target.closest('[data-duplicate-dismiss]')) {
    if (kind === 'create') pendingNewPet = null;
    else pendingPetChanges = null;
    hidePetDuplicateNotice(kind);
    document.getElementById(PET_FIELD_IDS[kind].name)?.focus();
  }
}

// ==================== REGISTER A NEW PET: POST /pets/create ====================

/**
 * Setup form submission handler
 */
function setupFormHandler() {
  const form = document.getElementById('petForm');
  if (!form) return;

  form.addEventListener('submit', event => {
    event.preventDefault();
    submitNewPet();
  });

  // A change to the details answers any open duplicate question
  form.addEventListener('input', () => {
    if (pendingNewPet) {
      pendingNewPet = null;
      hidePetDuplicateNotice('create');
    }
  });

  document.getElementById('petDuplicateNotice')?.addEventListener('click', event => handleDuplicateChoice(event, 'create'));
}

function resetPetForm() {
  const form = document.getElementById('petForm');
  form?.reset();
  showPetFieldErrors('create', {});
}

async function submitNewPet({ confirmNotDuplicate = false } = {}) {
  const form = document.getElementById('petForm');
  const errorContainer = document.getElementById('petError');
  const successContainer = document.getElementById('petSuccess');
  if (!form || petSubmitInProgress || isFormSubmitting(form)) return;

  hidePetFeedback(errorContainer);
  hidePetFeedback(successContainer);

  const values = readPetFormValues('create');
  const errors = getPetFieldErrors(values);
  showPetFieldErrors('create', errors);
  if (Object.keys(errors).length > 0) {
    hidePetDuplicateNotice('create');
    showPetFormError(errorContainer, Object.keys(errors).length === 1
      ? Object.values(errors)[0]
      : `Please fix the ${Object.keys(errors).length} highlighted fields.`);
    focusFirstPetFieldError('create', errors);
    return;
  }

  // Send plain text; every pet view escapes on render, so pre-escaping stored "&amp;" etc.
  const newPet = {
    user_id: currentUser.id,
    name: values.name,
    species: values.species,
    breed: values.breed || null,
    age: Number(values.age)
  };
  const body = confirmNotDuplicate && pendingNewPet ? { ...pendingNewPet, confirm_not_duplicate: true } : newPet;

  petSubmitInProgress = true;
  setFormSubmitting(form, true, 'Adding...', 'Add Pet');
  const confirmButton = document.querySelector('#petDuplicateNotice [data-duplicate-confirm]');
  if (confirmButton) updateButtonState(confirmButton, true, 'Adding...');

  try {
    const { ok, data } = await requestPetsApi('/pets/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    // A profile of this owner looks like the same pet: nothing was saved; the owner decides
    if (!ok && data.code === POSSIBLE_DUPLICATE_PET_CODE) {
      pendingNewPet = newPet;
      showPetDuplicateNotice('create', data.possible_duplicates);
      return;
    }

    if (!ok) {
      if (data.field) showPetFieldErrors('create', { [data.field]: data.error });
      throw new Error(data.error || 'Could not add pet.');
    }

    pendingNewPet = null;
    hidePetDuplicateNotice('create');
    showPetFeedback(successContainer, 'Pet added.', 'success');
    if (typeof showSuccess === 'function') showSuccess('Pet added.');

    resetPetForm();

    await loadPets(currentUser.id);
    setTimeout(() => hidePetFeedback(successContainer), 4000);
  } catch (error) {
    console.error('Error adding pet:', error);
    hidePetDuplicateNotice('create');
    showPetFormError(errorContainer, error.message);
    if (typeof showError === 'function') showError(error.message || 'Could not add pet.');
  } finally {
    petSubmitInProgress = false;
    setFormSubmitting(form, false, 'Adding...', 'Add Pet');
  }
}

/**
 * Show error message
 */
function showPetFormError(container, message) {
  showPetFeedback(container, message || 'Something went wrong.', 'error');
}

function showPetFeedback(container, message, type) {
  if (!container) return;
  displayMessage(container, message, type);
  container.classList.remove('hidden');
}

function hidePetFeedback(container) {
  if (!container) return;
  clearMessage(container);
  container.classList.add('hidden');
}

/**
 * Render medical records as a simple read-only history for pet owners.
 */
function getMedicalRecordDisplayValue(value) {
  return hasPetValue(value) ? String(value) : 'Not recorded';
}

function getMedicalRecordWeightDisplay(record) {
  const weight = getMedicalRecordDisplayValue(record?.weight);
  return weight === 'Not recorded' ? weight : `${weight} kg`;
}

function getMedicalRecordRecorderLabel(record) {
  if (!hasPetValue(record?.created_by)) return 'Not specified';
  if (hasPetValue(record.created_by_name)) return String(record.created_by_name);
  if (hasPetValue(record.recorded_by_name)) return String(record.recorded_by_name);
  return 'Not specified';
}

function getMedicalRecordHtml(record) {
  const recordDate = record.record_date || record.created_at
    ? formatDate(record.record_date || record.created_at)
    : 'Date not recorded';

  return `
    <article class="ph-dash-card">
      <div class="ph-dash-card-head">
        <p class="ph-dash-card-title">${escapeHtml(recordDate)}</p>
        <span class="ph-badge ph-badge-official">Official record</span>
      </div>
      <dl class="ph-dash-facts">
        <div><dt>Weight</dt> <dd>${escapeHtml(getMedicalRecordWeightDisplay(record))}</dd></div>
        <div><dt>Vaccination status</dt> <dd>${escapeHtml(getMedicalRecordDisplayValue(record.vaccination_status))}</dd></div>
        <div><dt>Treatment</dt> <dd>${escapeHtml(getMedicalRecordDisplayValue(record.treatment))}</dd></div>
        <div><dt>Recorded by</dt> <dd>${escapeHtml(getMedicalRecordRecorderLabel(record))}</dd></div>
        <div class="is-wide"><dt>Notes</dt> <dd>${escapeHtml(getMedicalRecordDisplayValue(record.medical_notes))}</dd></div>
      </dl>
    </article>
  `;
}
