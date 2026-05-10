// PetHub User Pets Management - API-based implementation

// Module-level user variable - matches appointments.js pattern
let currentUser = null;
let currentRecords = [];
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

  // Load pet profiles and read-only medical records.
  await Promise.all([loadPets(currentUser.id), loadMedicalRecords(currentUser.id)]);
  setupFormHandler();
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
    displayPetsList(data.pets || []);
  } catch (error) {
    console.error('Error loading pets:', error);
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
    <div class="rounded-2xl border border-red-200 bg-red-50 p-5 text-center text-red-700">
      <p class="font-semibold">Unable to load pets</p>
      <p class="mt-1 text-sm">${escapeHtml(message || 'Please refresh the page or try again later.')}</p>
    </div>
  `;
}

/**
 * Display pets list
 */
function displayPetsList(pets) {
  const container = document.getElementById('petsList');
  if (!container) return;

  if (!pets || pets.length === 0) {
    container.innerHTML = `
      <div class="text-center py-12 text-gray-500">
        <p class="text-4xl mb-3">🐾</p>
        <p class="font-medium">No pets yet</p>
        <p class="text-sm">Add your first pet using the form on the left</p>
      </div>
    `;
    return;
  }

  container.innerHTML = pets
    .map(
      (pet) => {
        const latestRecordSummary = getLatestMedicalRecordText(pet);
        const latestRecordDate = pet.latest_medical_record_date ? formatDate(pet.latest_medical_record_date) : '';
        return `
    <div class="bg-white border-l-4 border-orange-500 p-6 rounded-lg shadow-sm hover:shadow-md transition-all mb-4">
      <div class="flex justify-between items-start gap-4">
        <div class="flex-1">
          <div class="flex flex-wrap items-center gap-3 mb-3">
            <h3 class="font-semibold text-lg text-gray-900 flex items-center gap-2">
              <span>${getAnimalEmoji(pet.species)}</span>
              ${escapeHtml(pet.name || 'Pet')}
            </h3>
            <span class="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
              ${pet.medical_record_count || 0} medical record${pet.medical_record_count === 1 ? '' : 's'}
            </span>
          </div>
          <div class="grid grid-cols-2 gap-3 mt-3 text-sm">
            <p class="text-gray-600"><strong>Species:</strong> ${escapeHtml(pet.species || 'N/A')}</p>
            <p class="text-gray-600"><strong>Breed:</strong> ${escapeHtml(pet.breed || 'N/A')}</p>
            <p class="text-gray-600"><strong>Age:</strong> ${pet.age || pet.age === 0 ? escapeHtml(`${pet.age} years`) : 'N/A'}</p>
            <p class="text-gray-500 text-xs"><strong>Added:</strong> ${pet.created_at ? new Date(pet.created_at).toLocaleDateString() : 'Unknown'}</p>
          </div>
        </div>
        <div class="flex flex-col items-end gap-2">
          <button onclick="deletePetHandler(this, '${pet.id}')" class="inline-flex items-center gap-2 px-3 py-1 rounded-lg border border-red-300 bg-red-100 text-black text-sm font-semibold hover:bg-red-200 transition-all">
            <i class="ri-delete-bin-line"></i>Delete
          </button>
        </div>
      </div>
      <details class="mt-4 rounded-2xl border border-gray-100 bg-slate-50 p-4">
        <summary class="cursor-pointer font-medium text-slate-800">View details</summary>
        <div class="mt-3 text-sm text-gray-600 space-y-2">
          <p><strong>Pet ID:</strong> ${escapeHtml(pet.id || 'N/A')}</p>
          <p><strong>Medical records:</strong> ${pet.medical_record_count || 0}</p>
          <p><strong>Latest medical record:</strong> ${escapeHtml(latestRecordSummary)}</p>
          ${latestRecordDate ? `<p><strong>Latest record date:</strong> ${escapeHtml(latestRecordDate)}</p>` : ''}
          <p><strong>Profile created:</strong> ${pet.created_at ? new Date(pet.created_at).toLocaleDateString() : 'Unknown'}</p>
        </div>
      </details>
    </div>
  `;
      }
    )
    .join('');
}

function getLatestMedicalRecordText(pet) {
  if (!pet || !pet.latest_medical_record_summary) return 'No medical records yet';
  return String(pet.latest_medical_record_summary);
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
          name: escapeHtml(petName),
          species: escapeHtml(petSpecies),
          breed: petBreed ? escapeHtml(petBreed) : null,
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

    const response = await fetch(`${window.API_BASE_URL}/pets/delete/${petId}?user_id=${currentUser.id}`, {
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
 * Load medical records for the current user
 */
async function loadMedicalRecords(userId) {
  const container = document.getElementById('medicalRecordsContainer');
  if (container) {
    container.innerHTML = getMedicalRecordsLoadingHtml();
  }

  try {
    const response = await fetch(`${window.API_BASE_URL}/pets/medical-records?user_id=${userId}`);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(errorData.error || `Failed to load medical records (${response.status})`);
    }

    const data = await response.json();
    currentRecords = data.records || [];
    displayMedicalRecords(currentRecords);
  } catch (error) {
    console.error('Error loading medical records:', error);
    if (container) {
      container.innerHTML = getMedicalRecordsErrorHtml(error.message);
    }
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

function getMedicalRecordsErrorHtml(message) {
  return `
    <div class="rounded-2xl border border-red-200 bg-red-50 p-5 text-center text-red-700">
      <p class="font-semibold">Unable to load medical records</p>
      <p class="mt-1 text-sm">${escapeHtml(message || 'Please refresh the page or try again later.')}</p>
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

function getMedicalRecordPetLabel(record) {
  if (hasMedicalRecordValue(record?.pet_name)) return String(record.pet_name);
  if (hasMedicalRecordValue(record?.pet_id)) return `Pet ID: ${record.pet_id}`;
  return 'Pet profile unavailable';
}

function displayMedicalRecords(records) {
  const container = document.getElementById('medicalRecordsContainer');
  if (!container) return;

  if (!records || records.length === 0) {
    container.innerHTML = `
      <div class="rounded-2xl border border-gray-200 bg-white p-5">
        <p class="font-semibold text-gray-800">No medical records yet</p>
        <p class="mt-1 text-sm text-gray-500">Official records from clinic visits will appear here after they are added by staff.</p>
      </div>
    `;
    return;
  }

  const latestRecords = [...records]
    .sort((a, b) => new Date(b.record_date || b.created_at) - new Date(a.record_date || a.created_at));

  container.innerHTML = latestRecords.map((record) => {
    const recordDate = record.record_date || record.created_at
      ? formatDate(record.record_date || record.created_at)
      : 'Date not recorded';
    const petName = getMedicalRecordPetLabel(record);
    const recordedBy = getMedicalRecordRecorderLabel(record);

    return `
      <article class="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p class="text-xs font-semibold uppercase tracking-wide text-gray-500">Record date: ${escapeHtml(recordDate)}</p>
            <h4 class="mt-1 text-base font-semibold text-gray-900">${escapeHtml(petName)}</h4>
          </div>
          <span class="w-fit rounded-full bg-green-50 px-3 py-1 text-xs font-semibold text-green-700">Official record</span>
        </div>
        <dl class="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt class="font-semibold text-gray-500">Weight</dt>
            <dd class="mt-1 text-gray-800">${escapeHtml(getMedicalRecordWeightDisplay(record))}</dd>
          </div>
          <div>
            <dt class="font-semibold text-gray-500">Vaccination status</dt>
            <dd class="mt-1 text-gray-800">${escapeHtml(getMedicalRecordDisplayValue(record.vaccination_status))}</dd>
          </div>
          <div>
            <dt class="font-semibold text-gray-500">Treatment</dt>
            <dd class="mt-1 text-gray-800">${escapeHtml(getMedicalRecordDisplayValue(record.treatment))}</dd>
          </div>
          <div>
            <dt class="font-semibold text-gray-500">Recorded by</dt>
            <dd class="mt-1 text-gray-800">${escapeHtml(`Recorded by: ${recordedBy}`)}</dd>
          </div>
          <div class="sm:col-span-2">
            <dt class="font-semibold text-gray-500">Notes</dt>
            <dd class="mt-1 whitespace-pre-line text-gray-800">${escapeHtml(getMedicalRecordDisplayValue(record.medical_notes))}</dd>
          </div>
        </dl>
      </article>
    `;
  }).join('');
}
