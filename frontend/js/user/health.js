// PetHub Pet Owner Dashboard: Pet Health & AI Assistant (pages/user/health.html)
//
// Section 4 of the Pet Owner Dashboard. Two clearly separate parts:
// 1. Official clinic records (read-only): GET /pets/userPets and GET /pets/medical-records, both for the signed-in owner
//    only (requireAuth matches user_id to the session token, so another owner's id is refused with 403). Shows the
//    chosen pet's latest weight, vaccination status and treatment, and its full record history, only from records that
//    exist. Records are written by clinic administrators only; nothing on this page can create or change one.
// 2. The PetHub AI assistant: the existing Gemini assistant (js/shared/ai-widget.js -> POST /ai/chat). This page only
//    opens it, optionally with a general suggested question that names the pet's species ("dog"/"cat") and nothing
//    else. The assistant is sent the question and the page name only, never the pet's name, profile or records, and
//    the backend instructs it not to present answers as clinic records or as approved by a veterinarian.
// A pet can be chosen with ?pet=<id> (linked from My Pets); the choice is kept in the address for refreshes.

let healthUser = null;
let healthPets = [];
let healthRecords = [];
let healthPetsError = '';
let healthRecordsError = '';
let selectedHealthPetId = '';

document.addEventListener('DOMContentLoaded', () => {
  initializePetHealth();
});

async function initializePetHealth() {
  if (typeof window.API_BASE_URL === 'undefined') {
    console.error('API_BASE_URL not found. Ensure core/api.js is loaded first.');
    return;
  }

  const user = getUser();
  if (!isLoggedIn() || !user || !user.id || user.id === '0') {
    redirectToLogin();
    return;
  }
  healthUser = user;

  setupAssistantActions();
  await Promise.all([loadHealthPets(), loadHealthRecords()]);

  const requested = new URLSearchParams(window.location.search).get('pet');
  const initialPet = healthPets.find(pet => String(pet.id) === String(requested)) || healthPets[0];
  selectedHealthPetId = initialPet ? String(initialPet.id) : '';
  renderPetPicker();
  renderHealthRecords();
  renderAssistantSuggestions();
}

async function getOwnerJson(path) {
  const response = await fetch(`${window.API_BASE_URL}${path}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

async function loadHealthPets() {
  try {
    const data = await getOwnerJson(`/pets/userPets?user_id=${encodeURIComponent(healthUser.id)}`);
    healthPets = Array.isArray(data.pets) ? data.pets.filter(pet => pet && pet.id) : [];
    healthPetsError = '';
  } catch (error) {
    console.error('Error loading pets:', error);
    healthPets = [];
    healthPetsError = error.message || 'Please refresh the page or try again later.';
  }
}

async function loadHealthRecords() {
  try {
    const data = await getOwnerJson(`/pets/medical-records?user_id=${encodeURIComponent(healthUser.id)}`);
    healthRecords = Array.isArray(data.records) ? data.records : [];
    healthRecordsError = '';
  } catch (error) {
    console.error('Error loading medical records:', error);
    healthRecords = [];
    healthRecordsError = error.message || 'Please refresh the page or try again later.';
  }
}

function getSelectedHealthPet() {
  return healthPets.find(pet => String(pet.id) === selectedHealthPetId) || null;
}

function getErrorHtml(title, message) {
  return `
    <div class="ph-dash-error" role="alert">
      <p class="ph-dash-error-title">${escapeHtml(title)}</p>
      <p class="ph-dash-error-text">${escapeHtml(message)}</p>
    </div>
  `;
}

function renderPetPicker() {
  const picker = document.getElementById('healthPetPicker');
  if (!picker) return;

  if (healthPetsError) {
    picker.innerHTML = getErrorHtml('Unable to load pets', healthPetsError);
    return;
  }
  if (healthPets.length === 0) {
    picker.innerHTML = `
      <div class="ph-dash-empty">
        <p class="ph-dash-empty-title">No pets yet</p>
        <p class="ph-dash-empty-text">Add a pet on My Pets; its official records will appear here once the clinic adds them.</p>
        <a href="pets.html" class="ph-dash-link">Go to My Pets <i class="ri-arrow-right-line" aria-hidden="true"></i></a>
      </div>
    `;
    return;
  }

  picker.innerHTML = `
    <div class="ph-field">
      <label for="healthPetSelect" class="ph-label">Show records for</label>
      <select id="healthPetSelect" class="ph-input">
        ${healthPets.map(pet => `<option value="${escapeHtml(String(pet.id))}"${String(pet.id) === selectedHealthPetId ? ' selected' : ''}>${escapeHtml(getPetOptionLabel(pet))}</option>`).join('')}
      </select>
    </div>
  `;
  document.getElementById('healthPetSelect').addEventListener('change', event => {
    selectedHealthPetId = event.target.value;
    const url = new URL(window.location.href);
    url.searchParams.set('pet', selectedHealthPetId);
    history.replaceState(null, '', url);
    renderHealthRecords();
    renderAssistantSuggestions();
  });
}

function getPetOptionLabel(pet) {
  return [pet.name || 'Unnamed pet', pet.species].map(part => String(part || '').trim()).filter(Boolean).join(' - ');
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function getRecordDateLabel(record) {
  const raw = record?.record_date || record?.created_at;
  return raw ? formatDate(raw) : 'Date not recorded';
}

// The pet's records, newest first
function getSelectedPetRecords() {
  return healthRecords
    .filter(record => String(record.pet_id) === selectedHealthPetId)
    .sort((a, b) => (new Date(b.record_date || b.created_at || 0) - new Date(a.record_date || a.created_at || 0))
      || (new Date(b.created_at || 0) - new Date(a.created_at || 0)));
}

// Latest recorded value of one field: the newest record that has it. Nothing is shown for a field no record has.
function getLatestRecordedValue(records, field) {
  const record = records.find(entry => hasValue(entry[field]));
  return record ? { value: String(record[field]), date: getRecordDateLabel(record) } : null;
}

function renderHealthRecords() {
  const container = document.getElementById('healthRecords');
  if (!container) return;

  if (healthRecordsError) {
    container.innerHTML = getErrorHtml('Unable to load medical records', healthRecordsError);
    return;
  }
  const pet = getSelectedHealthPet();
  if (!pet) {
    container.innerHTML = healthPetsError
      ? getErrorHtml('Unable to load pets', 'Records are shown once your pets have loaded.')
      : `
        <div class="ph-dash-empty">
          <p class="ph-dash-empty-title">No pet selected</p>
          <p class="ph-dash-empty-text">Add a pet on My Pets to see its official records here.</p>
        </div>
      `;
    return;
  }

  const records = getSelectedPetRecords();
  if (records.length === 0) {
    container.innerHTML = `
      <div class="ph-dash-empty">
        <p class="ph-dash-empty-title">No official records for ${escapeHtml(pet.name || 'this pet')} yet</p>
        <p class="ph-dash-empty-text">The clinic adds a record after a completed visit. Weight, vaccination status and treatment appear here once one is recorded.</p>
      </div>
    `;
    return;
  }

  const latest = [
    ['Latest weight', getLatestRecordedValue(records, 'weight'), value => `${value} kg`],
    ['Vaccination status', getLatestRecordedValue(records, 'vaccination_status'), value => value],
    ['Latest treatment', getLatestRecordedValue(records, 'treatment'), value => value]
  ].filter(([, entry]) => entry);

  container.innerHTML = `
    ${latest.length ? `
      <div>
        <h3 class="ph-dash-card-title">Latest recorded for ${escapeHtml(pet.name || 'this pet')}</h3>
        <dl class="ph-dash-facts ph-dash-facts-3">
          ${latest.map(([label, entry, format]) => `
            <div>
              <dt>${escapeHtml(label)}</dt>
              <dd>${escapeHtml(format(entry.value))}</dd>
              <dd class="ph-dash-note">Recorded ${escapeHtml(entry.date)}</dd>
            </div>
          `).join('')}
        </dl>
      </div>
    ` : ''}
    <div>
      <h3 class="ph-dash-card-title">Record history (${records.length})</h3>
      <div class="ph-dash-stack mt-3">${records.map(getRecordCardHtml).join('')}</div>
    </div>
  `;
}

function getRecordCardHtml(record) {
  const show = value => (hasValue(value) ? String(value) : 'Not recorded');
  const weight = hasValue(record.weight) ? `${record.weight} kg` : 'Not recorded';
  const recordedBy = hasValue(record.created_by) && (record.created_by_name || record.recorded_by_name)
    ? String(record.created_by_name || record.recorded_by_name)
    : 'Not specified';
  return `
    <article class="ph-dash-card">
      <div class="ph-dash-card-head">
        <p class="ph-dash-card-title">${escapeHtml(getRecordDateLabel(record))}</p>
        <span class="ph-badge ph-badge-official">Official record</span>
      </div>
      <dl class="ph-dash-facts">
        <div><dt>Weight</dt> <dd>${escapeHtml(weight)}</dd></div>
        <div><dt>Vaccination status</dt> <dd>${escapeHtml(show(record.vaccination_status))}</dd></div>
        <div><dt>Treatment</dt> <dd>${escapeHtml(show(record.treatment))}</dd></div>
        <div><dt>Recorded by</dt> <dd>${escapeHtml(recordedBy)}</dd></div>
        <div class="is-wide"><dt>Medical notes</dt> <dd>${escapeHtml(show(record.medical_notes))}</dd></div>
      </dl>
    </article>
  `;
}

// ==================== AI ASSISTANT (the existing widget, opened from this page) ====================

// Only the species word is used in the suggested questions; the pet's name and records are never added
function getSpeciesWord() {
  const species = String(getSelectedHealthPet()?.species || '').trim().toLowerCase();
  return species === 'dog' || species === 'cat' ? species : 'pet';
}

function getSuggestedQuestions() {
  const species = getSpeciesWord();
  return [
    `What are general grooming tips for a ${species}?`,
    `What signs mean my ${species} should see a vet?`,
    `How can I prepare my ${species} for a check-up visit?`
  ];
}

function renderAssistantSuggestions() {
  const container = document.getElementById('aiSuggestions');
  const note = document.getElementById('aiSpeciesNote');
  if (note) note.textContent = getSpeciesWord() === 'pet' ? '' : ` (${getSpeciesWord()})`;
  if (!container) return;
  container.innerHTML = getSuggestedQuestions().map(question => `
    <button type="button" class="ph-btn ph-btn-secondary ph-btn-sm" data-ai-question="${escapeHtml(question)}">${escapeHtml(question)}</button>
  `).join('');
}

function setAssistantStatus(message) {
  const status = document.getElementById('aiAssistantStatus');
  if (status) status.textContent = message || '';
}

function setupAssistantActions() {
  renderAssistantSuggestions();

  document.getElementById('aiSuggestions')?.addEventListener('click', event => {
    const button = event.target.closest('[data-ai-question]');
    if (!button) return;
    if (!window.PetHubAI) {
      setAssistantStatus('The AI assistant could not be opened. Refresh the page and try again.');
      return;
    }
    setAssistantStatus('');
    window.PetHubAI.ask(button.dataset.aiQuestion);
  });

  document.getElementById('openAiAssistant')?.addEventListener('click', () => {
    if (!window.PetHubAI) {
      setAssistantStatus('The AI assistant could not be opened. Refresh the page and try again.');
      return;
    }
    setAssistantStatus('');
    window.PetHubAI.open();
  });
}
