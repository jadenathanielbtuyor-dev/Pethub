// Admin Dashboard > System Management > Services & booking: adding a service, the clinic's care reminder rules, and the
// service activity history (filtered and paged by the server). Loaded after js/admin/dashboard.js and uses its helpers.
// Everything here is stored in the database through the admin API: no service or schedule is written in this file.

const serviceActivityQuery = { page: 1, service_id: '', type: '', admin_id: '', from: '', to: '' };
const SERVICE_ACTIVITY_PAGE_SIZE = 10;
let serviceActivityLoaded = false;
let serviceActivityController = null;
let careRulesState = { loaded: false, rules: [], services: [], guidance: [], guidanceTypes: [] };

// ---------- Service activity ----------

function buildActivityParams() {
  const params = new URLSearchParams({ page: String(serviceActivityQuery.page), page_size: String(SERVICE_ACTIVITY_PAGE_SIZE) });
  ['service_id', 'type', 'admin_id', 'from', 'to'].forEach(key => {
    if (serviceActivityQuery[key]) params.set(key, serviceActivityQuery[key]);
  });
  return params;
}

async function loadServiceActivity({ focus = false } = {}) {
  const list = document.getElementById('serviceActivityList');
  const summary = document.getElementById('serviceActivitySummary');
  if (!list) return;
  if (serviceActivityController) serviceActivityController.abort();
  const controller = new AbortController();
  serviceActivityController = controller;
  list.setAttribute('aria-busy', 'true');
  if (!serviceActivityLoaded) list.innerHTML = '<p class="ph-dash-note" role="status">Loading service activity...</p>';
  try {
    const separator = getAdminUserIdQuery() ? '&' : '?';
    const response = await fetch(`${window.API_BASE_URL}/admin/services/activity${getAdminUserIdQuery()}${separator}${buildActivityParams().toString()}`, { signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success !== true) throw new Error(data.error || `Could not load the service activity (${response.status}).`);
    if (controller !== serviceActivityController) return;
    serviceActivityLoaded = true;
    serviceActivityQuery.page = Number(data.page) || 1;
    fillActivityFilterOptions(data);
    renderServiceActivity(data);
    if (focus) document.getElementById('serviceActivityTitle')?.focus();
  } catch (error) {
    if (error.name === 'AbortError' || controller !== serviceActivityController) return;
    list.innerHTML = `<p class="ph-dash-note" role="alert">${escapeHtml(error.message || 'Service activity is unavailable.')}</p>`;
    if (summary) summary.textContent = '';
    window.PetHubPagination?.render(document.getElementById('serviceActivityPagination'), { total: 0 }, goToActivityPage);
  } finally {
    if (controller === serviceActivityController) list.removeAttribute('aria-busy');
  }
}

function fillSelect(select, options, current, allLabel) {
  if (!select) return;
  const html = [`<option value="">${escapeHtml(allLabel)}</option>`]
    .concat(options.map(option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)).join('');
  if (select.dataset.optionsHtml !== html) {
    select.innerHTML = html;
    select.dataset.optionsHtml = html;
  }
  select.value = options.some(option => option.value === current) ? current : '';
}

function fillActivityFilterOptions(data) {
  const services = asArray(adminDashboardData.serviceCatalog).map(service => ({ value: String(service.id), label: service.name }));
  fillSelect(document.getElementById('serviceActivityService'), services, serviceActivityQuery.service_id, 'All services');
  fillSelect(document.getElementById('serviceActivityType'), asArray(data.types).map(type => ({ value: type.value, label: type.label })), serviceActivityQuery.type, 'All activity');
  fillSelect(document.getElementById('serviceActivityAdmin'), asArray(data.admins).map(admin => ({ value: String(admin.id), label: admin.name })), serviceActivityQuery.admin_id, 'All administrators');
}

function renderServiceActivity(data) {
  const list = document.getElementById('serviceActivityList');
  const summary = document.getElementById('serviceActivitySummary');
  const entries = asArray(data.entries);
  const total = Number(data.total) || 0;
  const first = total ? (serviceActivityQuery.page - 1) * SERVICE_ACTIVITY_PAGE_SIZE + 1 : 0;
  if (summary) summary.textContent = total ? `Showing ${first}–${first + entries.length - 1} of ${total}, newest first.` : '';
  window.PetHubPagination?.render(document.getElementById('serviceActivityPagination'), data, goToActivityPage, { label: 'Service activity pages' });
  if (!entries.length) {
    list.innerHTML = getAdminEmptyBlock('No service activity matches', 'Adding, editing or switching services appears here.');
    return;
  }
  list.innerHTML = `<ul role="list">${entries.map(entry => `
    <li class="ph-activity-row">
      <p><strong>${escapeHtml(entry.service_name)}</strong> · ${escapeHtml(entry.event_label)}</p>
      <p class="ph-dash-note">${escapeHtml(formatClinicTimestamp(entry.created_at))} · ${escapeHtml(entry.admin_name)}</p>
      ${entry.details ? `<p class="ph-dash-note mt-1">${escapeHtml(entry.details)}</p>` : ''}
    </li>`).join('')}</ul>`;
}

function goToActivityPage(page) {
  serviceActivityQuery.page = page;
  loadServiceActivity({ focus: true });
}

function applyActivityFilters(event) {
  event?.preventDefault();
  const from = document.getElementById('serviceActivityFrom')?.value || '';
  const to = document.getElementById('serviceActivityTo')?.value || '';
  const feedback = document.getElementById('serviceActivitySummary');
  if (from && to && from > to) {
    if (feedback) feedback.textContent = 'The start date must be on or before the end date.';
    return;
  }
  Object.assign(serviceActivityQuery, {
    page: 1,
    service_id: document.getElementById('serviceActivityService')?.value || '',
    type: document.getElementById('serviceActivityType')?.value || '',
    admin_id: document.getElementById('serviceActivityAdmin')?.value || '',
    from,
    to
  });
  loadServiceActivity();
}

// ---------- Care reminder rules ----------

async function loadCareRules() {
  const container = document.getElementById('careRulesContainer');
  if (!container) return;
  if (!careRulesState.loaded) container.innerHTML = '<p class="ph-dash-note" role="status">Loading care reminder rules...</p>';
  try {
    const response = await fetchWithRetry(() => fetch(`${window.API_BASE_URL}/admin/care-rules${getAdminUserIdQuery()}`));
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success !== true) throw new Error(data.error || `Could not load the rules (${response.status}).`);
    careRulesState = {
      loaded: true,
      rules: asArray(data.rules),
      services: asArray(data.services),
      guidance: asArray(data.starting_guidance),
      guidanceTypes: asArray(data.guidance_types)
    };
    renderCareRules();
  } catch (error) {
    container.innerHTML = `<p class="ph-dash-note" role="alert">${escapeHtml(error.message || 'Care reminder rules are unavailable.')}</p>`;
  }
}

function renderCareRules() {
  const container = document.getElementById('careRulesContainer');
  const guidance = document.getElementById('careGuidanceReference');
  if (guidance) {
    guidance.innerHTML = `<dl class="ph-dash-stack mt-2">${careRulesState.guidance.map(item => `<div><dt class="font-semibold">${escapeHtml(item.topic)}</dt><dd class="ph-dash-note">${escapeHtml(item.guidance)}</dd></div>`).join('')}</dl>`;
  }
  if (!container) return;
  if (!careRulesState.rules.length) {
    container.innerHTML = getAdminEmptyBlock('No care reminder rules yet', 'Without a rule, a completed service tells the owner to ask the clinic; no date is suggested.');
    return;
  }
  container.innerHTML = `<ul class="ph-dash-stack" role="list">${careRulesState.rules.map(rule => `
    <li class="ph-care-card">
      <div class="ph-group-head">
        <div>
          <p class="font-semibold">${escapeHtml(rule.service_name)} · ${escapeHtml(rule.species_label)} <span class="ph-badge ${rule.is_active ? 'ph-badge-official' : 'ph-badge-warning'}">${rule.is_active ? 'Enabled' : 'Disabled'}</span></p>
          <p class="ph-dash-note">Next visit suggested ${escapeHtml(rule.interval_label)} after the service · ${escapeHtml(rule.guidance_label)}</p>
          <p class="ph-dash-note mt-1">${escapeHtml(rule.description)}${rule.explanation ? ` ${escapeHtml(rule.explanation)}` : ''}</p>
          <p class="ph-dash-note mt-1">${rule.open_recommendations} open reminder${rule.open_recommendations === 1 ? '' : 's'} came from this rule.</p>
        </div>
        <button type="button" class="ph-btn ph-btn-secondary ph-btn-sm" data-care-rule-edit="${escapeHtml(String(rule.id))}"><i class="ri-edit-line" aria-hidden="true"></i>Edit rule</button>
      </div>
    </li>`).join('')}</ul>`;
}

function ensureCareRuleDialog() {
  let dialog = document.getElementById('careRuleDialog');
  if (dialog) return dialog;
  document.body.insertAdjacentHTML('beforeend', `
    <dialog id="careRuleDialog" class="ph-dialog ph-dialog-wide" aria-labelledby="careRuleTitle" aria-describedby="careRuleIntro">
      <form id="careRuleForm" class="ph-dialog-content" novalidate>
        <div class="ph-dialog-head">
          <div>
            <h2 id="careRuleTitle" class="ph-dialog-title">Care reminder rule</h2>
            <p id="careRuleIntro" class="ph-dash-note"></p>
          </div>
          <button type="button" class="ph-btn ph-btn-ghost ph-btn-sm" data-close-dialog aria-label="Close without saving"><i class="ri-close-line" aria-hidden="true"></i></button>
        </div>
        <p id="careRuleError" class="ph-field-error" role="alert" hidden></p>
        <div class="grid gap-4 md:grid-cols-2">
          <div class="ph-field" data-rule-field="service_id"><label for="careRuleService" class="ph-label">Service</label><select id="careRuleService" name="service_id" class="ph-input" required></select></div>
          <div class="ph-field" data-rule-field="species"><label for="careRuleSpecies" class="ph-label">For</label><select id="careRuleSpecies" name="species" class="ph-input"><option value="">All species the service is for</option><option value="Dog">Dogs only</option><option value="Cat">Cats only</option></select></div>
          <div class="ph-field" data-rule-field="min_interval_days"><label for="careRuleMin" class="ph-label">Earliest next visit (days after the service)</label><input id="careRuleMin" name="min_interval_days" type="number" min="1" max="1825" step="1" inputmode="numeric" class="ph-input" required></div>
          <div class="ph-field" data-rule-field="max_interval_days"><label for="careRuleMax" class="ph-label">Latest next visit (days after the service)</label><input id="careRuleMax" name="max_interval_days" type="number" min="1" max="1825" step="1" inputmode="numeric" class="ph-input" required></div>
          <div class="ph-field md:col-span-2" data-rule-field="guidance_type"><label for="careRuleGuidance" class="ph-label">Type</label><select id="careRuleGuidance" name="guidance_type" class="ph-input"></select></div>
          <div class="ph-field md:col-span-2" data-rule-field="description"><label for="careRuleDescription" class="ph-label">What owners read</label><input id="careRuleDescription" name="description" class="ph-input" maxlength="300" required placeholder="For example: Many coats need grooming every few weeks."></div>
          <div class="ph-field md:col-span-2" data-rule-field="explanation"><label for="careRuleExplanation" class="ph-label">Why (optional)</label><textarea id="careRuleExplanation" name="explanation" class="ph-input" rows="2" maxlength="600"></textarea></div>
          <label class="flex items-center gap-2 md:col-span-2"><input type="checkbox" name="is_active" id="careRuleActive"> Enabled (used for services completed from now on)</label>
        </div>
        <p id="careRuleImpact" class="ph-dash-note mt-3"></p>
        <div class="ph-dialog-actions">
          <button type="button" class="ph-btn ph-btn-secondary" data-close-dialog>Cancel</button>
          <button type="submit" id="careRuleSubmit" class="ph-btn ph-btn-primary">Save rule</button>
        </div>
      </form>
    </dialog>`);
  dialog = document.getElementById('careRuleDialog');
  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-close-dialog]')) dialog.close();
  });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    const returnTo = dialog.returnFocusTo;
    dialog.returnFocusTo = null;
    if (returnTo && returnTo.isConnected) returnTo.focus();
  });
  document.getElementById('careRuleForm').addEventListener('submit', saveCareRule);
  return dialog;
}

function setCareRuleError(message, field = '') {
  const error = document.getElementById('careRuleError');
  if (error) {
    error.textContent = message || '';
    error.hidden = !message;
  }
  document.querySelectorAll('#careRuleForm [aria-invalid="true"]').forEach(input => input.removeAttribute('aria-invalid'));
  const input = field ? document.querySelector(`#careRuleForm [data-rule-field="${CSS.escape(field)}"] input, #careRuleForm [data-rule-field="${CSS.escape(field)}"] select`) : null;
  if (input) {
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  }
}

function openCareRuleDialog(rule = null, returnFocus = null) {
  const dialog = ensureCareRuleDialog();
  const form = document.getElementById('careRuleForm');
  dialog.dataset.ruleId = rule ? String(rule.id) : '';
  dialog.returnFocusTo = returnFocus;
  form.elements.service_id.innerHTML = careRulesState.services.map(service => `<option value="${escapeHtml(String(service.id))}">${escapeHtml(service.name)}</option>`).join('');
  form.elements.guidance_type.innerHTML = careRulesState.guidanceTypes.map(type => `<option value="${escapeHtml(type.value)}">${escapeHtml(type.label)}</option>`).join('');
  document.getElementById('careRuleTitle').textContent = rule ? `Edit the ${rule.service_name} rule` : 'Add a care reminder rule';
  document.getElementById('careRuleIntro').textContent = 'Use clinic-approved intervals only. Owners see a suggestion, never an appointment, and decide themselves whether to book.';
  document.getElementById('careRuleImpact').textContent = rule
    ? `${rule.open_recommendations} open reminder${rule.open_recommendations === 1 ? '' : 's'} came from this rule; they keep their dates. Changes apply to services completed from now on.`
    : 'The rule applies to services completed from now on.';
  form.elements.service_id.value = rule ? String(rule.service_id) : String(careRulesState.services[0]?.id || '');
  form.elements.service_id.disabled = Boolean(rule);
  form.elements.species.value = rule?.species || '';
  form.elements.min_interval_days.value = rule ? String(rule.min_interval_days) : '';
  form.elements.max_interval_days.value = rule ? String(rule.max_interval_days) : '';
  form.elements.guidance_type.value = rule?.guidance_type || 'general';
  form.elements.description.value = rule?.description || '';
  form.elements.explanation.value = rule?.explanation || '';
  form.elements.is_active.checked = rule ? rule.is_active === true : true;
  setCareRuleError('');
  dialog.showModal();
  (rule ? form.elements.min_interval_days : form.elements.service_id).focus();
}

async function saveCareRule(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const dialog = document.getElementById('careRuleDialog');
  if (isFormSubmitting(form)) return;
  const ruleId = dialog.dataset.ruleId;
  const existing = careRulesState.rules.find(rule => String(rule.id) === ruleId);
  const body = {
    service_id: form.elements.service_id.value,
    species: form.elements.species.value || null,
    min_interval_days: Number(form.elements.min_interval_days.value),
    max_interval_days: Number(form.elements.max_interval_days.value),
    guidance_type: form.elements.guidance_type.value,
    description: form.elements.description.value.trim(),
    explanation: form.elements.explanation.value.trim(),
    is_active: form.elements.is_active.checked
  };
  if (!Number.isInteger(body.min_interval_days) || body.min_interval_days < 1 || body.min_interval_days > 1825) return setCareRuleError('Enter the earliest interval as whole days from 1 to 1825.', 'min_interval_days');
  if (!Number.isInteger(body.max_interval_days) || body.max_interval_days < body.min_interval_days || body.max_interval_days > 1825) return setCareRuleError('The latest interval must be a whole number of days, the same as or after the earliest.', 'max_interval_days');
  if (!body.description) return setCareRuleError('Enter what owners will read.', 'description');
  if (existing) body.expected_version = existing.version;

  setCareRuleError('');
  setFormSubmitting(form, true, 'Saving...', 'Save rule');
  try {
    const response = await fetchWithRetry(() => fetch(`${window.API_BASE_URL}/admin/care-rules${existing ? `/${encodeURIComponent(existing.id)}` : ''}${getAdminUserIdQuery()}`, {
      method: existing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success !== true) {
      setCareRuleError(data.error || `Could not save this rule (${response.status}).`, data.field || '');
      if (response.status === 409 && !data.field) await loadCareRules();
      return;
    }
    dialog.close();
    await loadCareRules();
    loadServiceActivity();
    showAdminStatus('success', `${data.rule?.service_name || 'The'} care reminder rule was saved. ${data.note || ''}`.trim());
  } catch (error) {
    setCareRuleError(error.message || 'Could not save this rule.');
  } finally {
    setFormSubmitting(form, false, 'Saving...', 'Save rule');
  }
}

// ---------- Wiring ----------

// First opening of the tab only (later changes reload what they affect), so the two are never requested twice at once
let servicesTabExtrasStarted = false;
function loadServicesTabExtras() {
  if (servicesTabExtrasStarted) return;
  servicesTabExtrasStarted = true;
  loadCareRules();
  loadServiceActivity();
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('addServiceButton')?.addEventListener('click', event => {
    openServiceDialog(getNewServiceDraft(), { mode: 'create', returnFocus: event.currentTarget });
  });
  document.getElementById('addCareRuleButton')?.addEventListener('click', event => {
    if (!careRulesState.loaded) return;
    openCareRuleDialog(null, event.currentTarget);
  });
  document.getElementById('careRulesContainer')?.addEventListener('click', event => {
    const button = event.target.closest('[data-care-rule-edit]');
    const rule = button ? careRulesState.rules.find(item => String(item.id) === button.dataset.careRuleEdit) : null;
    if (rule) openCareRuleDialog(rule, button);
  });
  document.getElementById('serviceActivityFilters')?.addEventListener('submit', applyActivityFilters);
  document.getElementById('serviceActivityReset')?.addEventListener('click', () => {
    document.getElementById('serviceActivityFilters')?.reset();
    applyActivityFilters();
  });
  // The rules and the history load when the Services & booking tab is first shown (dashboard.js switchSystemTab), also
  // when the page opens on it
  if (!document.getElementById('systemPanelServices')?.hidden) loadServicesTabExtras();
});

window.PetHubCatalogTools = Object.freeze({
  refreshActivity: () => { if (serviceActivityLoaded) loadServiceActivity(); },
  loadServicesTabExtras
});
