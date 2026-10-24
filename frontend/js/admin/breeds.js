// Admin Breed Catalog: one page of entries at a time from GET /admin/breeds (search, species, status and sort are
// applied by the server), with page navigation (js/shared/pagination.js). The current view is kept in the address bar,
// so a refresh shows the same page and filters.
const BREED_PAGE_SIZE = 20;
const breedQuery = { page: 1, species: 'all', status: 'active', q: '', sort: 'name_asc' };
let breedCatalogEntries = [];
let breedCatalogSaving = false;
let breedLoadController = null;
let breedSearchTimer = null;

document.addEventListener('DOMContentLoaded', initializeBreedCatalog);

async function initializeBreedCatalog() {
  const user = typeof getUser === 'function' ? getUser() : null;
  if (!isLoggedIn() || !user || String(user.role || '').toLowerCase() !== 'admin') {
    if (isLoggedIn() && user) redirectToDashboardForRole(user.role); else redirectToLogin();
    return;
  }
  readBreedQueryFromUrl();
  document.getElementById('breedCreateForm')?.addEventListener('submit', createBreedFromForm);
  document.getElementById('breedEditForm')?.addEventListener('submit', saveBreedName);
  document.getElementById('breedEditCancel')?.addEventListener('click', closeBreedEdit);
  document.getElementById('breedSearch')?.addEventListener('input', () => {
    clearTimeout(breedSearchTimer);
    // Wait for a pause in typing, so each keystroke does not send a request
    breedSearchTimer = setTimeout(() => changeBreedFilters({ q: document.getElementById('breedSearch').value.trim() }), 300);
  });
  document.getElementById('breedSpeciesFilter')?.addEventListener('change', event => changeBreedFilters({ species: event.target.value }));
  document.getElementById('breedStatusFilter')?.addEventListener('change', event => changeBreedFilters({ status: event.target.value }));
  document.getElementById('breedSortOrder')?.addEventListener('change', event => changeBreedFilters({ sort: event.target.value }));
  document.getElementById('breedCatalogList')?.addEventListener('click', handleBreedAction);
  await loadBreedCatalog();
}

function readBreedQueryFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const page = Number.parseInt(params.get('page') || '1', 10);
  breedQuery.page = Number.isInteger(page) && page > 0 ? page : 1;
  if (['all', 'Dog', 'Cat'].includes(params.get('species'))) breedQuery.species = params.get('species');
  if (['active', 'inactive', 'all'].includes(params.get('status'))) breedQuery.status = params.get('status');
  if (['name_asc', 'name_desc', 'updated_desc', 'species_name'].includes(params.get('sort'))) breedQuery.sort = params.get('sort');
  breedQuery.q = String(params.get('q') || '').slice(0, 60);
  const fields = { breedSearch: breedQuery.q, breedSpeciesFilter: breedQuery.species, breedStatusFilter: breedQuery.status, breedSortOrder: breedQuery.sort };
  Object.entries(fields).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.value = value;
  });
}

function writeBreedQueryToUrl() {
  const params = new URLSearchParams();
  if (breedQuery.page > 1) params.set('page', String(breedQuery.page));
  if (breedQuery.species !== 'all') params.set('species', breedQuery.species);
  if (breedQuery.status !== 'active') params.set('status', breedQuery.status);
  if (breedQuery.sort !== 'name_asc') params.set('sort', breedQuery.sort);
  if (breedQuery.q) params.set('q', breedQuery.q);
  const query = params.toString();
  try {
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  } catch (error) {
    // The address could not be updated (e.g. a file:// page); the view still works
  }
}

// A filter, search or sort change starts again at page 1
function changeBreedFilters(changes) {
  Object.assign(breedQuery, changes, { page: 1 });
  loadBreedCatalog();
}

function goToBreedPage(page) {
  breedQuery.page = page;
  loadBreedCatalog({ focusList: true });
}

async function loadBreedCatalog({ focusList = false } = {}) {
  const container = document.getElementById('breedCatalogList');
  const count = document.getElementById('breedCount');
  if (breedLoadController) breedLoadController.abort();
  const controller = new AbortController();
  breedLoadController = controller;
  if (container) container.setAttribute('aria-busy', 'true');
  if (container && !breedCatalogEntries.length) container.innerHTML = '<p role="status">Loading breed catalog...</p>';
  if (count) count.textContent = 'Loading...';

  const params = new URLSearchParams({
    page: String(breedQuery.page),
    page_size: String(BREED_PAGE_SIZE),
    species: breedQuery.species,
    status: breedQuery.status,
    sort: breedQuery.sort
  });
  if (breedQuery.q) params.set('q', breedQuery.q);
  try {
    const response = await fetch(`${window.API_BASE_URL}/admin/breeds?${params.toString()}`, { signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.error || `Could not load catalog (${response.status}).`);
    if (controller !== breedLoadController) return;
    breedCatalogEntries = Array.isArray(data.breeds) ? data.breeds : [];
    // The server moves a page past the end (after entries were disabled or filtered out) to the last page
    breedQuery.page = Number(data.page) || 1;
    writeBreedQueryToUrl();
    renderBreedCatalog(data);
    if (focusList) document.getElementById('breedListTitle')?.focus();
  } catch (error) {
    if (error.name === 'AbortError' || controller !== breedLoadController) return;
    breedCatalogEntries = [];
    if (count) count.textContent = '';
    if (container) container.innerHTML = `<div class="ph-dash-error" role="alert"><p class="ph-dash-error-title">Breed catalog unavailable</p><p class="ph-dash-error-text">${escapeHtml(error.message)}</p></div>`;
    window.PetHubPagination?.render(document.getElementById('breedPagination'), { total: 0 }, goToBreedPage);
  } finally {
    if (controller === breedLoadController && container) container.removeAttribute('aria-busy');
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

function renderBreedCatalog(pageInfo = {}) {
  const container = document.getElementById('breedCatalogList');
  const count = document.getElementById('breedCount');
  if (!container) return;
  const total = Number(pageInfo.total) || 0;
  const first = total ? (breedQuery.page - 1) * BREED_PAGE_SIZE + 1 : 0;
  const last = first ? first + breedCatalogEntries.length - 1 : 0;
  if (count) count.textContent = total ? `Showing ${first}–${last} of ${total} ${total === 1 ? 'entry' : 'entries'}` : '0 entries';
  window.PetHubPagination?.render(document.getElementById('breedPagination'), pageInfo, goToBreedPage, { label: 'Breed catalog pages' });

  if (!breedCatalogEntries.length) {
    container.innerHTML = '<div class="ph-dash-empty"><p class="ph-dash-empty-title">No catalog entries match</p><p class="ph-dash-empty-text">Try another search or filter.</p></div>';
    return;
  }
  container.innerHTML = breedCatalogEntries.map(entry => {
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
    // The same page and filters again; the server moves to the last page if this one is now past the end
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
