let breedCatalogEntries = [];
let breedCatalogSaving = false;

document.addEventListener('DOMContentLoaded', initializeBreedCatalog);

async function initializeBreedCatalog() {
  const user = typeof getUser === 'function' ? getUser() : null;
  if (!isLoggedIn() || !user || String(user.role || '').toLowerCase() !== 'admin') {
    if (isLoggedIn() && user) redirectToDashboardForRole(user.role); else redirectToLogin();
    return;
  }
  document.getElementById('breedCreateForm')?.addEventListener('submit', createBreedFromForm);
  document.getElementById('breedEditForm')?.addEventListener('submit', saveBreedName);
  document.getElementById('breedEditCancel')?.addEventListener('click', closeBreedEdit);
  document.getElementById('breedSearch')?.addEventListener('input', renderBreedCatalog);
  document.getElementById('breedSpeciesFilter')?.addEventListener('change', renderBreedCatalog);
  document.getElementById('breedStatusFilter')?.addEventListener('change', renderBreedCatalog);
  document.getElementById('breedCatalogList')?.addEventListener('click', handleBreedAction);
  await loadBreedCatalog();
}

async function loadBreedCatalog() {
  const container = document.getElementById('breedCatalogList');
  if (container) container.innerHTML = '<p role="status">Loading breed catalog...</p>';
  try {
    const response = await fetch(`${window.API_BASE_URL}/admin/breeds`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.error || `Could not load catalog (${response.status}).`);
    breedCatalogEntries = Array.isArray(data.breeds) ? data.breeds : [];
    renderBreedCatalog();
  } catch (error) {
    if (container) container.innerHTML = `<div class="ph-dash-error" role="alert"><p class="ph-dash-error-title">Breed catalog unavailable</p><p class="ph-dash-error-text">${escapeHtml(error.message)}</p></div>`;
  }
}

// Only http(s) links become clickable, like the API's own check (validators/breedCatalogValidator.js): escaping alone
// would still let a javascript: address saved directly in the database run when an administrator clicks "Source"
function getSafeSourceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch (error) {
    return '';
  }
}

function renderBreedCatalog() {
  const container = document.getElementById('breedCatalogList');
  const count = document.getElementById('breedCount');
  if (!container) return;
  const query = String(document.getElementById('breedSearch')?.value || '').trim().toLowerCase();
  const species = document.getElementById('breedSpeciesFilter')?.value || 'all';
  const status = document.getElementById('breedStatusFilter')?.value || 'active';
  const entries = breedCatalogEntries.filter(entry => {
    const matchesSpecies = species === 'all' || entry.species === species;
    const matchesStatus = status === 'all' || Boolean(entry.is_active) === (status === 'active');
    const matchesText = !query || `${entry.name} ${entry.source_organization || ''} ${entry.recognition_status || ''}`.toLowerCase().includes(query);
    return matchesSpecies && matchesStatus && matchesText;
  });
  if (count) count.textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
  if (!entries.length) {
    container.innerHTML = '<div class="ph-dash-empty"><p class="ph-dash-empty-title">No catalog entries match</p><p class="ph-dash-empty-text">Try another search or filter.</p></div>';
    return;
  }
  container.innerHTML = entries.map(entry => {
    const source = entry.source_organization
      ? `<span>${escapeHtml(entry.source_organization)}${entry.source_reviewed_at ? ` · reviewed ${escapeHtml(entry.source_reviewed_at)}` : ''}</span>`
      : '<span>No source recorded</span>';
    const sourceUrl = getSafeSourceUrl(entry.source_url);
    const link = sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Source</a>` : '';
    const modified = entry.updated_at ? new Date(entry.updated_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Date not recorded';
    const activeText = entry.is_active ? 'Enabled for new pets' : 'Disabled for new pets';
    return `<article class="ph-breed-catalog-row">
      <div class="ph-breed-catalog-main"><p class="ph-dash-card-title">${escapeHtml(entry.name)} <span class="ph-badge">${escapeHtml(entry.species)}</span></p><div class="ph-breed-catalog-meta"><span>${escapeHtml(entry.recognition_status || 'unverified')}</span>${source}${link}<span>${activeText} · updated ${escapeHtml(modified)}</span></div></div>
      <div class="ph-dash-card-actions"><button type="button" class="ph-btn ph-btn-secondary ph-btn-sm" data-breed-edit="${escapeHtml(entry.id)}">Edit name</button><button type="button" class="ph-btn ph-btn-ghost ph-btn-sm" data-breed-toggle="${escapeHtml(entry.id)}">${entry.is_active ? 'Disable' : 'Enable'}</button></div>
    </article>`;
  }).join('');
}

async function createBreedFromForm(event) {
  event.preventDefault();
  if (breedCatalogSaving) return;
  const form = event.currentTarget;
  breedCatalogSaving = true;
  setBreedFormBusy(form, true, 'Saving...');
  try {
    const response = await fetch(`${window.API_BASE_URL}/admin/breeds`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        species: document.getElementById('breedSpecies').value,
        name: document.getElementById('breedName').value,
        source_organization: document.getElementById('breedSource').value,
        source_url: document.getElementById('breedSourceUrl').value
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.error || 'Could not add this breed.');
    form.reset();
    showBreedFeedback('Breed added as Unverified and enabled for new selections.', 'success');
    await loadBreedCatalog();
  } catch (error) {
    showBreedFeedback(error.message, 'error');
  } finally {
    breedCatalogSaving = false;
    setBreedFormBusy(form, false, 'Add breed');
  }
}

function handleBreedAction(event) {
  const editButton = event.target.closest('[data-breed-edit]');
  const toggleButton = event.target.closest('[data-breed-toggle]');
  if (editButton) openBreedEdit(editButton.dataset.breedEdit);
  if (toggleButton) toggleBreedActive(toggleButton.dataset.breedToggle);
}

function openBreedEdit(id) {
  const entry = breedCatalogEntries.find(item => String(item.id) === String(id));
  if (!entry) return;
  document.getElementById('breedEditId').value = entry.id;
  document.getElementById('breedEditName').value = entry.name;
  document.getElementById('breedEditForm').hidden = false;
  document.getElementById('breedCreateForm').hidden = true;
  document.getElementById('breedEditName').focus();
}

function closeBreedEdit() {
  document.getElementById('breedEditForm').hidden = true;
  document.getElementById('breedCreateForm').hidden = false;
  document.getElementById('breedEditId').value = '';
}

async function saveBreedName(event) {
  event.preventDefault();
  const id = document.getElementById('breedEditId').value;
  const name = document.getElementById('breedEditName').value;
  await updateBreed(id, { name }, 'Breed name updated.');
}

async function toggleBreedActive(id) {
  const entry = breedCatalogEntries.find(item => String(item.id) === String(id));
  if (!entry || breedCatalogSaving) return;
  const action = entry.is_active ? 'disable' : 'enable';
  if (!window.confirm(`${action[0].toUpperCase()}${action.slice(1)} ${entry.name} for new pet selections? Existing pet profiles keep their saved value.`)) return;
  await updateBreed(id, { is_active: !entry.is_active }, entry.is_active ? 'Breed disabled for new selections.' : 'Breed enabled for new selections.');
}

async function updateBreed(id, changes, successMessage) {
  if (breedCatalogSaving) return;
  breedCatalogSaving = true;
  try {
    const response = await fetch(`${window.API_BASE_URL}/admin/breeds/${encodeURIComponent(id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.error || 'Could not update this breed.');
    closeBreedEdit();
    showBreedFeedback(successMessage, 'success');
    await loadBreedCatalog();
  } catch (error) {
    showBreedFeedback(error.message, 'error');
  } finally {
    breedCatalogSaving = false;
  }
}

function setBreedFormBusy(form, busy, buttonText) {
  if (!form) return;
  form.querySelectorAll('input, select, button').forEach(control => { control.disabled = busy; });
  const button = form.querySelector('button[type="submit"]');
  if (button) button.textContent = buttonText;
}

function showBreedFeedback(message, type) {
  const output = document.getElementById('breedCatalogFeedback');
  if (!output) return;
  output.className = `mb-4 rounded-lg p-3 text-sm ${type === 'error' ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`;
  output.textContent = message;
}
