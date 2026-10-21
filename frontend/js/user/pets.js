// PetHub Pet Owner Dashboard: My Pets (pages/user/pets.html)
//
// Section 2 of the Pet Owner Dashboard. Only the signed-in owner's pets are ever requested: every call sends the
// owner's user_id with the session token, and backend/middleware/requireAuth.js answers 403 if they do not match.
// - List:    GET /pets/userPets?user_id=      -> pets (id, name, species, breed, age, created_at, medical record count)
// - Add:     POST /pets/create                -> the server re-validates (name and species required, Dog or Cat only,
//                                                age a non-negative number) and returns the saved pet
// - Delete:  DELETE /pets/delete/:id?user_id= -> after a second click; the server deletes only a pet of this owner
//                                                (404 otherwise), and the list is reloaded from the server afterwards
// - Details: one pet's profile plus its official medical history from GET /pets/medical-records?user_id=
//            (record_date, weight, vaccination_status, treatment, medical_notes, recorded by), read-only.
// Medical records are created by clinic administrators only (the owner route POST /pets/medical-records/create always
// answers 403), and there is no API for editing a saved pet profile, so neither is offered here.
// Success messages appear only after the server has confirmed the change.

// Module-level user variable - matches appointments.js pattern
let currentUser = null;
let currentPets = [];
let currentRecords = [];
let medicalRecordsError = '';
let medicalRecordsLoaded = false;
let openPetId = '';
let petSubmitInProgress = false;

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

  // Bind the form before loading data so an early submit is handled instead of reloading the page.
  setupFormHandler();
  setupPetListActions();

  // Load pet profiles and read-only medical records.
  await Promise.all([loadPets(currentUser.id), loadMedicalRecords(currentUser.id)]);

  // A link such as pets.html?pet=<id> (from the Overview) opens that pet once its profile has loaded
  const requestedPet = new URLSearchParams(window.location.search).get('pet');
  if (requestedPet && getPetById(requestedPet)) openPetDetail(requestedPet, { focus: true });
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
    const response = await fetch(`${window.API_BASE_URL}/pets/userPets?user_id=${userId}`);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(errorData.error || `Failed to load pets (${response.status})`);
    }

    const data = await response.json();
    currentPets = Array.isArray(data.pets) ? data.pets : [];
    displayPetsList(currentPets);
    if (openPetId) {
      if (getPetById(openPetId)) renderPetDetail(openPetId);
      else closePetDetail();
    }
  } catch (error) {
    console.error('Error loading pets:', error);
    currentPets = [];
    if (container) {
      container.innerHTML = getPetsErrorHtml(error.message);
    }
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

function getPetAgeText(pet) {
  return pet.age || pet.age === 0 ? `${pet.age} year${Number(pet.age) === 1 ? '' : 's'}` : 'Not recorded';
}

function getSpeciesBadgeHtml(species) {
  const value = String(species || '').trim();
  const modifier = value.toLowerCase() === 'dog' ? ' ph-badge-dog' : value.toLowerCase() === 'cat' ? ' ph-badge-cat' : '';
  return `<span class="ph-badge${modifier}">${escapeHtml(value || 'Species not recorded')}</span>`;
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
        <p class="ph-dash-empty-text">Add your first pet with the Add a pet form.</p>
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
          <div><dt>Added</dt> <dd>${pet.created_at ? escapeHtml(formatDate(pet.created_at)) : 'Unknown'}</dd></div>
        </dl>
        <div class="ph-dash-card-actions">
          <button type="button" class="ph-btn ph-btn-secondary ph-btn-sm" data-pet-view="${id}" aria-controls="petDetailPanel">
            <i class="ri-file-list-3-line" aria-hidden="true"></i>View details<span class="sr-only"> for ${name}</span>
          </button>
          <button type="button" class="ph-btn ph-btn-ghost ph-btn-sm" data-pet-delete="${id}">
            <i class="ri-delete-bin-line" aria-hidden="true"></i>Delete<span class="sr-only"> ${name}</span>
          </button>
        </div>
      </article>
    `;
  }).join('');
}

// "View details" and "Delete" on the pet cards (one listener for the whole list)
function setupPetListActions() {
  const container = document.getElementById('petsList');
  if (container) {
    container.addEventListener('click', event => {
      const viewButton = event.target.closest('[data-pet-view]');
      if (viewButton) {
        openPetDetail(viewButton.dataset.petView, { focus: true });
        return;
      }
      const deleteButton = event.target.closest('[data-pet-delete]');
      if (deleteButton) deletePetHandler(deleteButton, deleteButton.dataset.petDelete);
    });
  }

  document.getElementById('petDetailClose')?.addEventListener('click', () => {
    const petId = openPetId;
    closePetDetail();
    document.querySelector(`[data-pet-view="${CSS.escape(petId)}"]`)?.focus();
  });
}

// ==================== ONE PET: PROFILE AND OFFICIAL MEDICAL HISTORY (read-only) ====================

function openPetDetail(petId, { focus = false } = {}) {
  if (!getPetById(petId)) return;
  openPetId = String(petId);
  renderPetDetail(openPetId);
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
  const panel = document.getElementById('petDetailPanel');
  if (panel) panel.hidden = true;
  const url = new URL(window.location.href);
  url.searchParams.delete('pet');
  history.replaceState(null, '', url);
}

function getPetRecords(petId) {
  const id = String(petId);
  return currentRecords
    .filter(record => String(record.pet_id) === id)
    .sort((a, b) => new Date(b.record_date || b.created_at) - new Date(a.record_date || a.created_at));
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
        <p class="ph-dash-note">Details you entered when you added this pet.</p>
        <dl class="ph-dash-facts">
          <div><dt>Name</dt> <dd>${escapeHtml(pet.name || 'Not recorded')}</dd></div>
          <div><dt>Species</dt> <dd>${escapeHtml(pet.species || 'Not recorded')}</dd></div>
          <div><dt>Breed</dt> <dd>${escapeHtml(pet.breed || 'Not recorded')}</dd></div>
          <div><dt>Age</dt> <dd>${escapeHtml(getPetAgeText(pet))}</dd></div>
          <div class="is-wide"><dt>Added</dt> <dd>${pet.created_at ? escapeHtml(formatDate(pet.created_at)) : 'Unknown'}</dd></div>
        </dl>
        <div class="ph-dash-card-actions">
          <a href="appointments.html" class="ph-btn ph-btn-secondary ph-btn-sm"><i class="ri-calendar-check-line" aria-hidden="true"></i>Appointments</a>
          <a href="health.html?pet=${encodedId}" class="ph-btn ph-btn-ghost ph-btn-sm"><i class="ri-heart-pulse-line" aria-hidden="true"></i>Pet Health &amp; AI Assistant</a>
        </div>
      </div>
      <div>
        <div class="ph-dash-card-head">
          <h3 class="ph-dash-card-title">Official medical history</h3>
          <span class="ph-badge ph-badge-official"><i class="ri-shield-check-line" aria-hidden="true"></i>From the clinic</span>
        </div>
        <p class="ph-dash-note">Recorded by clinic staff after completed visits. You can read these records; only the clinic can add them.</p>
        <div class="ph-dash-stack mt-3">${getPetRecordsHtml(pet)}</div>
      </div>
    </div>
  `;
}

function getPetRecordsHtml(pet) {
  if (medicalRecordsError) {
    return `
      <div class="ph-dash-error" role="alert">
        <p class="ph-dash-error-title">Unable to load medical records</p>
        <p class="ph-dash-error-text">${escapeHtml(medicalRecordsError)}</p>
      </div>
    `;
  }
  if (!medicalRecordsLoaded) return getMedicalRecordsLoadingHtml();

  const records = getPetRecords(pet.id);
  if (!records.length) {
    return `
      <div class="ph-dash-empty">
        <p class="ph-dash-empty-title">No medical records yet</p>
        <p class="ph-dash-empty-text">Official records for ${escapeHtml(pet.name || 'this pet')} will appear here after the clinic adds them.</p>
      </div>
    `;
  }
  return records.map(getMedicalRecordHtml).join('');
}

/**
 * Get emoji for animal species
 * Note: Using getAnimalEmoji from utils.js for consistency across all pages
 */

/**
 * Setup form submission handler
 */
function setupFormHandler() {
  const form = document.getElementById('petForm');
  const errorContainer = document.getElementById('petError');
  const successContainer = document.getElementById('petSuccess');
  const ageInput = document.getElementById('petAge');
  const ageWarningContainer = document.getElementById('petAgeWarning');

  if (!form) return;

  if (ageInput) {
    ageInput.addEventListener('input', () => updateAgeWarning(ageInput.value, ageWarningContainer));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (petSubmitInProgress || isFormSubmitting(form)) return;

    hidePetFeedback(errorContainer);
    hidePetFeedback(successContainer);

    // Get form values
    const petName = document.getElementById('petName').value.trim();
    const petSpecies = document.getElementById('petType').value.trim();
    const petBreed = document.getElementById('petBreed').value.trim();
    const petAge = document.getElementById('petAge').value;

    // Validation: Pet name required and length check
    const nameValidation = validateInput(petName, 'Pet name', 1, 50);
    if (!nameValidation.valid) {
      showPetFormError(errorContainer, nameValidation.error);
      return;
    }

    // Validation: Species required
    if (!petSpecies) {
      showPetFormError(errorContainer, 'Species is required');
      return;
    }

    // Validation: Breed max length (optional field)
    if (petBreed && petBreed.length > 50) {
      showPetFormError(errorContainer, 'Breed must be less than 50 characters');
      return;
    }

    // Validation: Age must be valid (optional but if provided, must be valid)
    const ageValidation = validateAge(petAge);
    if (!ageValidation.valid) {
      showPetFormError(errorContainer, ageValidation.error);
      return;
    }
    updateAgeWarning(petAge, ageWarningContainer);

    petSubmitInProgress = true;
    setFormSubmitting(form, true, 'Adding...', 'Add Pet');

    try {
      // Send POST request to create pet
      const response = await fetch(`${window.API_BASE_URL}/pets/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: currentUser.id,
          // Send plain text; every pet view escapes on render, so pre-escaping stored "&amp;" etc.
          name: petName,
          species: petSpecies,
          breed: petBreed || null,
          age: petAge ? parseInt(petAge) : null
        })
      });

      const data = await response.json().catch(() => ({}));

      // Check response
      if (!response.ok) {
        throw new Error(data.error || 'Could not add pet.');
      }

      showPetFeedback(successContainer, 'Pet added.', 'success');
      if (typeof showSuccess === 'function') showSuccess('Pet added.');

      // Reset form
      form.reset();
      updateAgeWarning('', ageWarningContainer);

      await Promise.all([loadPets(currentUser.id), loadMedicalRecords(currentUser.id)]);
      setTimeout(() => hidePetFeedback(successContainer), 4000);
    } catch (error) {
      console.error('Error adding pet:', error);
      showPetFormError(errorContainer, error.message);
      if (typeof showError === 'function') showError(error.message || 'Could not add pet.');
    } finally {
      petSubmitInProgress = false;
      setFormSubmitting(form, false, 'Adding...', 'Add Pet');
    }
  });
}

function updateAgeWarning(age, container) {
  if (!container) return;
  const parsedAge = Number(age);
  const shouldWarn = age !== '' && Number.isFinite(parsedAge) && parsedAge > 30;
  container.classList.toggle('hidden', !shouldWarn);
}

/**
 * Delete pet handler
 */
async function deletePetHandler(button, petId) {
  if (button?.dataset?.loading === 'true') return;

  if (!requireSecondClick(button, {
    key: `delete-pet:${petId}`,
    message: 'Click again to confirm'
  })) {
    return;
  }

  const originalText = button?.textContent?.trim() || 'Delete';

  try {
    if (button) {
      updateButtonState(button, true, 'Deleting...', originalText);
    }

    const response = await fetch(`${window.API_BASE_URL}/pets/delete/${encodeURIComponent(petId)}?user_id=${currentUser.id}`, {
      method: 'DELETE'
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || 'Could not delete pet.');
    }

    await Promise.all([loadPets(currentUser.id), loadMedicalRecords(currentUser.id)]);
    if (typeof showSuccess === 'function') showSuccess('Pet deleted.');
  } catch (error) {
    console.error('Error deleting pet:', error);
    if (button) {
      updateButtonState(button, false, 'Deleting...', originalText);
    }
    if (typeof showError === 'function') {
      showError(error.message || 'Could not delete pet.');
    }
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
 * Load medical records for the current user (read-only; shown in each pet's details)
 */
async function loadMedicalRecords(userId) {
  medicalRecordsLoaded = false;
  medicalRecordsError = '';
  if (openPetId) renderPetDetail(openPetId);

  try {
    const response = await fetch(`${window.API_BASE_URL}/pets/medical-records?user_id=${userId}`);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(errorData.error || `Failed to load medical records (${response.status})`);
    }

    const data = await response.json();
    currentRecords = Array.isArray(data.records) ? data.records : [];
  } catch (error) {
    console.error('Error loading medical records:', error);
    currentRecords = [];
    medicalRecordsError = error.message || 'Please refresh the page or try again later.';
  } finally {
    medicalRecordsLoaded = true;
    if (openPetId) renderPetDetail(openPetId);
  }
}

function getMedicalRecordsLoadingHtml() {
  return `
    <div class="dashboard-loading-state" role="status" aria-live="polite">
      <div class="dashboard-loading-spinner" aria-hidden="true"></div>
      <div>
        <p class="dashboard-loading-title">Loading medical records...</p>
        <p class="dashboard-loading-copy">Fetching the latest PetHub records.</p>
      </div>
    </div>
  `;
}

/**
 * Render medical records as a simple read-only history for pet owners.
 */
function hasMedicalRecordValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function getMedicalRecordDisplayValue(value) {
  return hasMedicalRecordValue(value) ? String(value) : 'Not recorded';
}

function getMedicalRecordWeightDisplay(record) {
  const weight = getMedicalRecordDisplayValue(record?.weight);
  return weight === 'Not recorded' ? weight : `${weight} kg`;
}

function getMedicalRecordRecorderLabel(record) {
  if (!hasMedicalRecordValue(record?.created_by)) return 'Not specified';
  if (hasMedicalRecordValue(record.created_by_name)) return String(record.created_by_name);
  if (hasMedicalRecordValue(record.recorded_by_name)) return String(record.recorded_by_name);
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
