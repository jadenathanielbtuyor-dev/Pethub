// "Several pets" booking on My Appointments: one booking for 2-6 of the owner's pets, each with its own service, sent to
// POST /appointments/group. The pets are seen one after another from the chosen start time (the clinic schedule allows
// one appointment at a time); the summary shows each pet's time slot before anything is sent. The server checks every
// pet and service again and saves the booking completely or not at all. If one pet's choice is refused, only that pet
// is marked and every other selection stays. Uses the pets and services js/user/appointments.js already loaded.

const GROUP_MIN_PETS = 2;
const GROUP_MAX_PETS = 6;
const groupBooking = { petIds: [], serviceByPet: {}, errors: {}, submitting: false, ready: false };

function groupServicesForPet(pet) {
  const catalog = window.AppointmentDurations;
  if (!catalog || !pet) return [];
  return catalog.getServices().filter(service => catalog.isBookable(service.name) && catalog.isAvailableForSpecies(service.name, pet.species));
}

function groupPet(petId) {
  return (typeof currentUserPets !== 'undefined' ? currentUserPets : []).find(pet => String(pet.id) === String(petId)) || null;
}

function describePet(pet) {
  const parts = [pet.species, pet.breed, Number.isFinite(Number(pet.age)) && pet.age !== null && pet.age !== '' ? `${pet.age} yr${Number(pet.age) === 1 ? '' : 's'}` : ''].filter(Boolean);
  return parts.join(' · ');
}

function minutesOfTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function clockLabel(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  return `${hours % 12 || 12}:${String(totalMinutes % 60).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

function durationLabel(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${minutes} min`;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

function renderGroupPetChoices() {
  const container = document.getElementById('groupPetChoices');
  if (!container) return;
  const pets = typeof currentUserPets !== 'undefined' ? currentUserPets : [];
  if (pets.length < GROUP_MIN_PETS) {
    container.innerHTML = `<p class="ph-dash-note">You need at least two registered pets to book them together. <a class="ph-dash-link" href="pets.html">Add a pet profile</a>.</p>`;
    return;
  }
  container.innerHTML = pets.map(pet => {
    const checked = groupBooking.petIds.includes(String(pet.id));
    const order = checked ? groupBooking.petIds.indexOf(String(pet.id)) + 1 : '';
    return `<label class="ph-pet-choice">
      <input type="checkbox" value="${escapeHtml(String(pet.id))}" data-group-pet ${checked ? 'checked' : ''}>
      <span><strong>${escapeHtml(pet.name)}</strong>${order ? ` <span class="ph-badge">#${order}</span>` : ''}<br><span class="ph-dash-note">${escapeHtml(describePet(pet) || 'Details not recorded')}</span></span>
    </label>`;
  }).join('');
}

function renderGroupServices() {
  const container = document.getElementById('groupPetServices');
  const sameButton = document.getElementById('groupSameService');
  if (!container) return;
  if (sameButton) sameButton.hidden = groupBooking.petIds.length < 2;
  if (!groupBooking.petIds.length) {
    container.innerHTML = '<p class="ph-dash-note">Choose your pets above; each one gets its own service here.</p>';
    return;
  }
  container.innerHTML = groupBooking.petIds.map((petId, index) => {
    const pet = groupPet(petId);
    if (!pet) return '';
    const services = groupServicesForPet(pet);
    const selected = groupBooking.serviceByPet[petId] || '';
    const error = groupBooking.errors[petId] || '';
    const options = ['<option value="">Choose a service</option>']
      .concat(services.map(service => `<option value="${escapeHtml(service.id)}"${service.id === selected ? ' selected' : ''}>${escapeHtml(service.name)} (${escapeHtml(durationLabel(service.durationMinutes))})</option>`)).join('');
    const selectId = `groupService-${escapeHtml(String(petId))}`;
    return `<div class="ph-group-pet${error ? ' has-error' : ''}" data-group-pet-row="${escapeHtml(String(petId))}">
      <div class="ph-group-pet-head"><label for="${selectId}" class="font-semibold">#${index + 1} ${escapeHtml(pet.name)}</label><span class="ph-dash-note">${escapeHtml(describePet(pet))}</span></div>
      ${services.length
        ? `<select id="${selectId}" class="ph-input mt-2" data-group-service="${escapeHtml(String(petId))}" aria-describedby="${selectId}-error"${error ? ' aria-invalid="true"' : ''}>${options}</select>`
        : `<p class="ph-dash-note mt-2">No service can be booked online for ${escapeHtml(String(pet.species || 'this pet').toLowerCase())}s right now. Remove ${escapeHtml(pet.name)} from this booking or contact the clinic.</p>`}
      <p id="${selectId}-error" class="ph-field-error mt-1"${error ? '' : ' hidden'}>${escapeHtml(error)}</p>
    </div>`;
  }).join('');
}

// The booking as it would be sent: each pet's slot follows the previous one
function getGroupPlan() {
  const date = document.getElementById('groupBookingDate')?.value || '';
  const time = document.getElementById('groupBookingTime')?.value || '';
  const start = minutesOfTime(time);
  let cursor = start;
  const rows = groupBooking.petIds.map(petId => {
    const pet = groupPet(petId);
    const service = window.AppointmentDurations?.getService(groupBooking.serviceByPet[petId] || '');
    const row = { petId, pet, service, start: null, end: null };
    if (service && Number.isInteger(service.durationMinutes) && cursor !== null) {
      row.start = cursor;
      row.end = cursor + service.durationMinutes;
      cursor = row.end;
    } else {
      cursor = null;
    }
    return row;
  });
  const total = rows.reduce((sum, row) => sum + (row.service?.durationMinutes || 0), 0);
  return { date, time, start, rows, total, complete: rows.length >= GROUP_MIN_PETS && rows.every(row => row.service && row.start !== null) };
}

function getGroupProblem(plan) {
  if (groupBooking.petIds.length < GROUP_MIN_PETS) return 'Choose at least two pets.';
  if (plan.rows.some(row => !row.service)) return 'Choose a service for each pet.';
  if (!plan.date || !plan.time) return 'Choose the date and the start time.';
  const validation = typeof getAppointmentDateTimeValidation === 'function' ? getAppointmentDateTimeValidation(plan.date, plan.time) : { message: '' };
  if (validation.message) return validation.message;
  if (plan.start !== null && plan.start + plan.total > 24 * 60) return 'These services would run past midnight. Choose an earlier start time.';
  return '';
}

function renderGroupSummary() {
  const plan = getGroupPlan();
  const list = document.getElementById('groupSummaryList');
  const total = document.getElementById('groupSummaryTotal');
  const button = document.getElementById('groupBookingSubmit');
  const hint = document.getElementById('groupBookingHint');
  if (list) {
    list.innerHTML = plan.rows.length
      ? plan.rows.map((row, index) => `<li><strong>#${index + 1} ${escapeHtml(row.pet?.name || 'Pet')}</strong> (${escapeHtml(describePet(row.pet || {}) || 'pet')}) · ${escapeHtml(row.service?.name || 'service not chosen')}${row.start !== null ? ` · ${escapeHtml(clockLabel(row.start))} – ${escapeHtml(clockLabel(row.end))} (${escapeHtml(durationLabel(row.service.durationMinutes))})` : ''}</li>`).join('')
      : '<li class="ph-dash-note">No pets chosen yet.</li>';
  }
  if (total) {
    total.textContent = plan.complete
      ? `${plan.rows.length} pets on ${typeof formatAppointmentDateDisplay === 'function' && plan.date ? formatAppointmentDateDisplay(plan.date) : plan.date || 'the chosen date'}, seen one after another: ${clockLabel(plan.start)} to ${clockLabel(plan.start + plan.total)} (${durationLabel(plan.total)} in total).`
      : 'Choose pets, a service for each, a date and a start time to see each pet\'s time slot.';
  }
  const problem = getGroupProblem(plan);
  if (button) button.disabled = Boolean(problem) || groupBooking.submitting;
  if (hint) {
    hint.textContent = groupBooking.submitting ? '' : problem;
    hint.hidden = !hint.textContent;
  }
}

function setGroupMessage(text, type = 'info') {
  const element = document.getElementById('groupBookingMessage');
  if (!element) return;
  element.className = `rounded-lg p-3 text-sm ${type === 'error' ? 'bg-red-50 text-red-700' : type === 'success' ? 'bg-green-50 text-green-700' : 'bg-blue-50 text-blue-700'}`;
  element.innerHTML = text;
  element.hidden = !text;
}

function refreshGroupForm() {
  renderGroupPetChoices();
  renderGroupServices();
  renderGroupSummary();
}

async function submitGroupBooking(event) {
  event.preventDefault();
  if (groupBooking.submitting) return;
  const plan = getGroupPlan();
  const problem = getGroupProblem(plan);
  if (problem) {
    setGroupMessage(escapeHtml(problem), 'error');
    return;
  }
  groupBooking.submitting = true;
  groupBooking.errors = {};
  setGroupMessage('');
  const button = document.getElementById('groupBookingSubmit');
  const original = button ? button.innerHTML : '';
  if (button) {
    button.disabled = true;
    button.textContent = 'Sending booking...';
  }
  try {
    const response = await fetch(`${window.API_BASE_URL}/appointments/group`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: currentUser?.id,
        appointment_date: plan.date,
        appointment_time: plan.time.length === 5 ? `${plan.time}:00` : plan.time,
        items: plan.rows.map(row => ({ pet_id: row.petId, service_id: row.service.id }))
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success !== true) {
      const itemErrors = Array.isArray(data.item_errors) ? data.item_errors : [];
      itemErrors.forEach(item => {
        const petId = item.pet_id || groupBooking.petIds[(Number(item.position) || 1) - 1];
        if (petId) groupBooking.errors[String(petId)] = item.error;
      });
      if (data.position && data.pet_id && !itemErrors.length) groupBooking.errors[String(data.pet_id)] = 'This pet\'s time slot overlaps another appointment.';
      const suggestion = data.suggested_time
        ? ` <button type="button" class="ph-text-button" data-group-use-time="${escapeHtml(String(data.suggested_time).slice(0, 5))}">Use ${escapeHtml(clockLabel(minutesOfTime(data.suggested_time)))} instead</button>`
        : '';
      setGroupMessage(`${escapeHtml(data.error || `Could not send the booking (${response.status}).`)}${suggestion}`, 'error');
      // A service switched off after this page loaded: reload the list; the other choices stay
      if (response.status === 409 && itemErrors.length && typeof loadServiceCatalog === 'function') await loadServiceCatalog();
      renderGroupServices();
      return;
    }
    const count = Array.isArray(data.appointments) ? data.appointments.length : plan.rows.length;
    setGroupMessage(escapeHtml(data.already_booked
      ? 'You already sent this booking. It is listed in your appointments.'
      : `Booking sent for ${count} pets. Each pet's appointment is Pending until the clinic approves it; you will be emailed about each one.`), 'success');
    groupBooking.petIds = [];
    groupBooking.serviceByPet = {};
    document.getElementById('groupBookingForm')?.reset();
    if (typeof loadAppointments === 'function' && currentUser?.id) await loadAppointments(currentUser.id);
  } catch (error) {
    setGroupMessage(escapeHtml(error.message || 'Could not send the booking. Nothing was booked; please try again.'), 'error');
  } finally {
    groupBooking.submitting = false;
    if (button) button.innerHTML = original;
    refreshGroupForm();
  }
}

function setBookingMode(mode) {
  const group = mode === 'group';
  document.getElementById('bookingModeSingle')?.setAttribute('aria-pressed', String(!group));
  document.getElementById('bookingModeGroup')?.setAttribute('aria-pressed', String(group));
  const single = document.getElementById('appointmentForm');
  const groupForm = document.getElementById('groupBookingForm');
  const closed = !document.getElementById('bookingClosedNotice')?.hidden;
  const modeSwitch = document.getElementById('bookingModeSwitch');
  if (modeSwitch) modeSwitch.hidden = closed;
  if (groupForm) groupForm.hidden = !group || closed;
  if (single && !closed) single.hidden = group;
  if (group) refreshGroupForm();
}

function initGroupBooking() {
  const form = document.getElementById('groupBookingForm');
  if (!form) return;
  document.getElementById('bookingModeSingle')?.addEventListener('click', () => setBookingMode('single'));
  document.getElementById('bookingModeGroup')?.addEventListener('click', () => setBookingMode('group'));
  const dateInput = document.getElementById('groupBookingDate');
  if (dateInput && typeof getTodayDateValue === 'function') dateInput.min = getTodayDateValue();

  document.getElementById('groupPetChoices')?.addEventListener('change', event => {
    const box = event.target.closest('[data-group-pet]');
    if (!box) return;
    const id = String(box.value);
    if (box.checked) {
      if (groupBooking.petIds.length >= GROUP_MAX_PETS) {
        box.checked = false;
        setGroupMessage(escapeHtml(`One booking can include up to ${GROUP_MAX_PETS} pets. Book the others separately.`), 'error');
        return;
      }
      if (!groupBooking.petIds.includes(id)) groupBooking.petIds.push(id);
    } else {
      groupBooking.petIds = groupBooking.petIds.filter(petId => petId !== id);
      delete groupBooking.serviceByPet[id];
      delete groupBooking.errors[id];
    }
    setGroupMessage('');
    refreshGroupForm();
  });
  document.getElementById('groupPetServices')?.addEventListener('change', event => {
    const select = event.target.closest('[data-group-service]');
    if (!select) return;
    groupBooking.serviceByPet[select.dataset.groupService] = select.value;
    delete groupBooking.errors[select.dataset.groupService];
    renderGroupServices();
    renderGroupSummary();
    document.getElementById(select.id)?.focus();
  });
  document.getElementById('groupSameService')?.addEventListener('click', () => {
    const firstId = groupBooking.petIds[0];
    const serviceId = groupBooking.serviceByPet[firstId];
    if (!serviceId) {
      setGroupMessage(escapeHtml('Choose a service for the first pet, then use it for the others.'), 'error');
      return;
    }
    const service = window.AppointmentDurations.getService(serviceId);
    const skipped = [];
    groupBooking.petIds.slice(1).forEach(petId => {
      const pet = groupPet(petId);
      if (groupServicesForPet(pet).some(option => option.id === serviceId)) {
        groupBooking.serviceByPet[petId] = serviceId;
        delete groupBooking.errors[petId];
      } else if (pet) skipped.push(pet.name);
    });
    setGroupMessage(escapeHtml(skipped.length
      ? `${service?.name || 'That service'} was set for the other pets except ${skipped.join(', ')}, who cannot have it; choose another service for ${skipped.length === 1 ? 'that pet' : 'them'}.`
      : `${service?.name || 'That service'} was set for every pet.`), skipped.length ? 'error' : 'info');
    renderGroupServices();
    renderGroupSummary();
  });
  ['groupBookingDate', 'groupBookingTime'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', renderGroupSummary);
    document.getElementById(id)?.addEventListener('change', renderGroupSummary);
  });
  document.getElementById('groupBookingMessage')?.addEventListener('click', event => {
    const use = event.target.closest('[data-group-use-time]');
    if (!use) return;
    document.getElementById('groupBookingTime').value = use.dataset.groupUseTime;
    groupBooking.errors = {};
    setGroupMessage('');
    renderGroupServices();
    renderGroupSummary();
    document.getElementById('groupBookingTime').focus();
  });
  form.addEventListener('submit', submitGroupBooking);
  document.addEventListener('pethub:booking-data', () => {
    groupBooking.ready = true;
    // Pets removed from the account meanwhile are dropped from the selection
    groupBooking.petIds = groupBooking.petIds.filter(petId => groupPet(petId));
    if (!document.getElementById('groupBookingForm')?.hidden) refreshGroupForm();
    setBookingMode(document.getElementById('bookingModeGroup')?.getAttribute('aria-pressed') === 'true' ? 'group' : 'single');
  });
  refreshGroupForm();
}

document.addEventListener('DOMContentLoaded', initGroupBooking);
