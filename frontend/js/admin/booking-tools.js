// Admin Dashboard: multi-pet bookings, rescheduling, and each pet's care reminders. Loaded after js/admin/dashboard.js
// and uses its helpers (adminDashboardData, escapeHtml, fetchWithRetry, showAdminStatus, loadDashboardOverview, ...).
// - Appointment Management: pets booked together appear under one booking row. The buttons in a pet's row change only
//   that pet's appointment; "Cancel whole booking" (with a confirmation that lists the affected pets) changes every
//   still-open pet appointment of the booking (POST /admin/appointment-groups/:id/cancel).
// - "Reschedule" moves one appointment to a free time (PUT /admin/appointments/:id/schedule); the owner is emailed.
// - Pet Owners & Records: a pet's care reminders, with "Set next date" for clinic staff.

function getGroupMembers(groupId) {
  return asArray(adminDashboardData.appointments)
    .filter(appointment => String(appointment.group_id || '') === String(groupId))
    .sort((first, second) => (Number(first.group_position) || 0) - (Number(second.group_position) || 0));
}

function getGroupReference(groupId) {
  const compact = String(groupId || '').replace(/[^A-Za-z0-9]/g, '');
  return compact ? `BK-${compact.slice(0, 8).toUpperCase()}` : 'Booking';
}

function isOpenAppointment(appointment) {
  return ['Pending', 'Approved'].includes(getAppointmentStatus(appointment.status));
}

// "Pet 2 of 3 in booking BK-…" under the pet's name (dashboard.js displayAppointmentsTable)
function getGroupMemberBadgeHtml(appointment) {
  if (!appointment?.group_id) return '';
  const members = getGroupMembers(appointment.group_id);
  return `<p class="mt-1"><span class="ph-badge">Pet ${escapeHtml(String(appointment.group_position || '?'))} of ${members.length} · ${escapeHtml(getGroupReference(appointment.group_id))}</span></p>`;
}

function formatGroupDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${minutes} min`;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

function getGroupHeaderHtml(groupId, shownCount) {
  const members = getGroupMembers(groupId);
  const first = members[0] || {};
  const open = members.filter(isOpenAppointment);
  const total = members.reduce((sum, member) => sum + (Number(member.estimated_duration_minutes) || 0), 0);
  const owner = getUserById(first.user_id);
  const shown = shownCount < members.length ? ` (${shownCount} shown by the current filters)` : '';
  return `
    <tr class="ph-group-row">
      <td colspan="9">
        <div class="ph-group-head ph-group-head-stack">
          <div>
            <p class="font-semibold"><i class="ri-stack-line" aria-hidden="true"></i> Multi-pet booking ${escapeHtml(getGroupReference(groupId))} · ${members.length} pets${escapeHtml(shown)}</p>
            <p class="ph-dash-note">${escapeHtml(owner?.fullname || getAppointmentOwnerLabel(first))} · ${escapeHtml(formatTableDate(first.appointment_date, 'date not recorded'))} · seen one after another, ${escapeHtml(formatGroupDuration(total))} in total. The buttons in each pet's row change only that pet's appointment.</p>
          </div>
          ${open.length ? `<button type="button" class="ph-btn ph-btn-ghost ph-btn-sm" data-group-cancel="${escapeHtml(String(groupId))}"><i class="ri-close-circle-line" aria-hidden="true"></i>Cancel whole booking (${open.length} open)</button>` : '<span class="ph-dash-note">No open pet appointments</span>'}
        </div>
      </td>
    </tr>`;
}

// The rows in their current order, except that the pets of one booking stay together under its booking row
function renderGroupedAppointmentRows(appointments, rowHtml) {
  const list = asArray(appointments);
  const emitted = new Set();
  const html = [];
  list.forEach(appointment => {
    if (!appointment.group_id) {
      html.push(rowHtml(appointment));
      return;
    }
    const groupId = String(appointment.group_id);
    if (emitted.has(groupId)) return;
    emitted.add(groupId);
    const shown = list.filter(item => String(item.group_id || '') === groupId)
      .sort((first, second) => (Number(first.group_position) || 0) - (Number(second.group_position) || 0));
    html.push(getGroupHeaderHtml(groupId, shown.length));
    shown.forEach(member => html.push(rowHtml(member)));
  });
  return html.join('');
}

// ---------- Dialogs ----------

function ensureBookingToolsDialog(id, html) {
  let dialog = document.getElementById(id);
  if (dialog) return dialog;
  document.body.insertAdjacentHTML('beforeend', html);
  dialog = document.getElementById(id);
  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-close-dialog]')) dialog.close();
  });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    const returnTo = dialog.returnFocusTo;
    dialog.returnFocusTo = null;
    if (returnTo && returnTo.isConnected) returnTo.focus();
  });
  return dialog;
}

function setDialogError(id, message) {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = message || '';
  element.hidden = !message;
}

function openGroupCancelDialog(button) {
  const groupId = button.dataset.groupCancel;
  const members = getGroupMembers(groupId);
  const open = members.filter(isOpenAppointment);
  const dialog = ensureBookingToolsDialog('groupCancelDialog', `
    <dialog id="groupCancelDialog" class="ph-dialog" aria-labelledby="groupCancelTitle" aria-describedby="groupCancelIntro">
      <div class="ph-dialog-content">
        <div class="ph-dialog-head">
          <div>
            <h2 id="groupCancelTitle" class="ph-dialog-title">Cancel the whole booking?</h2>
            <p id="groupCancelIntro" class="ph-dash-note">Every open pet appointment below becomes Cancelled (by the clinic), and the owner is emailed for each pet. Completed or already cancelled pets are not changed.</p>
          </div>
          <button type="button" class="ph-btn ph-btn-ghost ph-btn-sm" data-close-dialog aria-label="Close without cancelling"><i class="ri-close-line" aria-hidden="true"></i></button>
        </div>
        <p id="groupCancelError" class="ph-field-error" role="alert" hidden></p>
        <ul id="groupCancelPets" class="ph-dash-stack mt-2"></ul>
        <div class="ph-dialog-actions">
          <button type="button" class="ph-btn ph-btn-secondary" data-close-dialog>Keep the booking</button>
          <button type="button" id="groupCancelConfirm" class="ph-btn ph-btn-primary">Cancel every open pet appointment</button>
        </div>
      </div>
    </dialog>`);
  dialog.dataset.groupId = String(groupId);
  dialog.returnFocusTo = button;
  document.getElementById('groupCancelPets').innerHTML = members.map(member => `
    <li>${escapeHtml(getAppointmentPetLabel(member))} · ${escapeHtml(displayValue(member.service_type, 'service'))} · ${escapeHtml(getAppointmentTimeDisplay(member))} ·
      <strong>${isOpenAppointment(member) ? `${escapeHtml(getAppointmentStatus(member.status))} → Cancelled` : `${escapeHtml(getAppointmentStatus(member.status))} (not changed)`}</strong></li>`).join('');
  document.getElementById('groupCancelConfirm').textContent = `Cancel ${open.length} open pet appointment${open.length === 1 ? '' : 's'}`;
  setDialogError('groupCancelError', '');
  const confirm = document.getElementById('groupCancelConfirm');
  confirm.onclick = () => confirmGroupCancel(dialog, confirm);
  dialog.showModal();
  dialog.querySelector('[data-close-dialog].ph-btn-secondary')?.focus();
}

async function confirmGroupCancel(dialog, confirm) {
  if (confirm.disabled) return;
  const groupId = dialog.dataset.groupId;
  const original = confirm.textContent;
  confirm.disabled = true;
  confirm.textContent = 'Cancelling...';
  try {
    const response = await fetchWithRetry(() => fetch(`${window.API_BASE_URL}/admin/appointment-groups/${encodeURIComponent(groupId)}/cancel${getAdminUserIdQuery()}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success !== true) {
      setDialogError('groupCancelError', data.error || `Could not cancel this booking (${response.status}).`);
      if (response.status === 409) await loadDashboardOverview();
      return;
    }
    dialog.close();
    await loadDashboardOverview();
    const count = asArray(data.cancelled_appointment_ids).length;
    showAdminStatus('success', `Booking ${getGroupReference(groupId)} cancelled: ${count} pet appointment${count === 1 ? '' : 's'} changed to Cancelled${asArray(data.unchanged).length ? `; ${data.unchanged.length} left as they were` : ''}. The owner is emailed for each pet.`);
  } catch (error) {
    setDialogError('groupCancelError', error.message || 'Could not cancel this booking.');
  } finally {
    confirm.disabled = false;
    confirm.textContent = original;
  }
}

function clinicTodayInputValue() {
  const parts = clinicClockParts(new Date());
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function openRescheduleDialog(button) {
  const appointment = asArray(adminDashboardData.appointments).find(item => String(item.id) === String(button.dataset.appointmentReschedule));
  if (!appointment) return;
  const dialog = ensureBookingToolsDialog('rescheduleDialog', `
    <dialog id="rescheduleDialog" class="ph-dialog" aria-labelledby="rescheduleTitle" aria-describedby="rescheduleIntro">
      <form id="rescheduleForm" class="ph-dialog-content" novalidate>
        <div class="ph-dialog-head">
          <div>
            <h2 id="rescheduleTitle" class="ph-dialog-title">Reschedule appointment</h2>
            <p id="rescheduleIntro" class="ph-dash-note"></p>
          </div>
          <button type="button" class="ph-btn ph-btn-ghost ph-btn-sm" data-close-dialog aria-label="Close without rescheduling"><i class="ri-close-line" aria-hidden="true"></i></button>
        </div>
        <p id="rescheduleError" class="ph-field-error" role="alert" hidden></p>
        <div class="grid gap-4 md:grid-cols-2">
          <div class="ph-field"><label for="rescheduleDate" class="ph-label">New date</label><input id="rescheduleDate" name="appointment_date" type="date" class="ph-input" required></div>
          <div class="ph-field"><label for="rescheduleTime" class="ph-label">New start time</label><input id="rescheduleTime" name="appointment_time" type="time" class="ph-input" required></div>
        </div>
        <p class="ph-dash-note mt-3">The time is checked against the clinic schedule when you save. The status stays the same and the owner is emailed the new time.</p>
        <div class="ph-dialog-actions">
          <button type="button" class="ph-btn ph-btn-secondary" data-close-dialog>Keep the current time</button>
          <button type="submit" id="rescheduleSubmit" class="ph-btn ph-btn-primary">Save new time</button>
        </div>
      </form>
    </dialog>`);
  const form = document.getElementById('rescheduleForm');
  form.onsubmit = event => saveReschedule(event, dialog);
  dialog.dataset.appointmentId = String(appointment.id);
  dialog.expected = {
    expected_status: getAppointmentStatus(appointment.status),
    expected_date: normalizeDashboardDateValue(appointment.appointment_date),
    expected_time: String(appointment.appointment_time || '').slice(0, 5)
  };
  dialog.returnFocusTo = button;
  const groupNote = appointment.group_id ? ` This pet is part of booking ${getGroupReference(appointment.group_id)}; only this pet's appointment moves.` : '';
  document.getElementById('rescheduleIntro').textContent = `${getAppointmentPetLabel(appointment)} · ${displayValue(appointment.service_type, 'service')} · now ${formatTableDate(appointment.appointment_date, 'no date')}, ${getAppointmentTimeDisplay(appointment)} (${getAppointmentDurationLabel(appointment)}).${groupNote}`;
  form.elements.appointment_date.min = clinicTodayInputValue();
  form.elements.appointment_date.value = dialog.expected.expected_date;
  form.elements.appointment_time.value = dialog.expected.expected_time;
  setDialogError('rescheduleError', '');
  dialog.showModal();
  form.elements.appointment_date.focus();
}

async function saveReschedule(event, dialog) {
  event.preventDefault();
  const form = event.currentTarget;
  if (isFormSubmitting(form)) return;
  const date = form.elements.appointment_date.value;
  const time = form.elements.appointment_time.value;
  if (!date || !time) {
    setDialogError('rescheduleError', 'Choose the new date and start time.');
    return;
  }
  if (date === dialog.expected.expected_date && time === dialog.expected.expected_time) {
    setDialogError('rescheduleError', 'Choose a different date or time.');
    return;
  }
  setDialogError('rescheduleError', '');
  setFormSubmitting(form, true, 'Saving...', 'Save new time');
  try {
    const response = await fetchWithRetry(() => fetch(`${window.API_BASE_URL}/admin/appointments/${encodeURIComponent(dialog.dataset.appointmentId)}/schedule${getAdminUserIdQuery()}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appointment_date: date, appointment_time: time, ...dialog.expected })
    }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success !== true) {
      const suggestion = data.suggested_time ? ` The next free start that day is ${formatSuggestedAppointmentTimeDisplay(data.suggested_time)}.` : '';
      setDialogError('rescheduleError', `${data.error || `Could not reschedule (${response.status}).`}${suggestion}`);
      return;
    }
    dialog.close();
    await loadDashboardOverview();
    showAdminStatus('success', `Appointment moved to ${formatTableDate(date)}, ${formatSuggestedAppointmentTimeDisplay(time)}. The owner is emailed the new time.`);
  } catch (error) {
    setDialogError('rescheduleError', error.message || 'Could not reschedule this appointment.');
  } finally {
    setFormSubmitting(form, false, 'Saving...', 'Save new time');
  }
}

// ---------- A pet's care reminders (Pet Owners & Records) ----------

const CARE_STATUS_LABELS = { active: 'Shown to the owner', acknowledged: 'Owner acknowledged', dismissed: 'Owner dismissed', superseded: 'Replaced (kept for the record)' };

function formatCareDate(value) {
  return value ? formatTableDate(value, 'not recorded') : '';
}

function careDueText(recommendation) {
  if (!recommendation.due_from) return 'No date suggested: the clinic has not set a follow-up schedule for this service.';
  return recommendation.due_to && recommendation.due_to !== recommendation.due_from
    ? `Suggested next ${recommendation.service_name}: ${formatCareDate(recommendation.due_from)} to ${formatCareDate(recommendation.due_to)}`
    : `Suggested next ${recommendation.service_name}: around ${formatCareDate(recommendation.due_from)}`;
}

async function loadAdminPetCareReminders(pet) {
  const list = document.getElementById('adminPetCareList');
  if (!list || !pet) return;
  try {
    const response = await fetchWithRetry(() => fetch(`${window.API_BASE_URL}/admin/pets/${encodeURIComponent(pet.id)}/care-recommendations${getAdminUserIdQuery()}`));
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success !== true) throw new Error(data.error || `Could not load care reminders (${response.status}).`);
    if (String(document.getElementById('adminPetCareSection')?.dataset.petId) !== String(pet.id)) return;
    renderAdminPetCareReminders(pet, asArray(data.recommendations), data.available !== false);
  } catch (error) {
    list.innerHTML = `<p class="ph-dash-note" role="alert">${escapeHtml(error.message || 'Care reminders are unavailable.')}</p>`;
  }
}

function renderAdminPetCareReminders(pet, recommendations, available) {
  const list = document.getElementById('adminPetCareList');
  if (!list) return;
  if (!available) {
    list.innerHTML = '<p class="ph-dash-note">Care reminders are unavailable until the clinic finishes an update.</p>';
    return;
  }
  const covered = new Set(recommendations.map(item => String(item.source_appointment_id || '')));
  const withoutReminder = asArray(adminDashboardData.appointments)
    .filter(appointment => String(appointment.pet_id) === String(pet.id) && getAppointmentStatus(appointment.status) === 'Completed' && !covered.has(String(appointment.id)));
  const cards = recommendations.map(item => `
    <article class="ph-care-card${item.basis === 'needs_review' ? ' is-review' : ''}">
      <p class="ph-care-due">${escapeHtml(careDueText(item))}</p>
      <p class="ph-dash-note mt-1">${escapeHtml(item.explanation)}</p>
      <p class="mt-2"><span class="ph-badge">${escapeHtml(item.basis_label)}</span> ${item.guidance_label ? `<span class="ph-badge ph-badge-official">${escapeHtml(item.guidance_label)}</span>` : ''} <span class="ph-badge">${escapeHtml(CARE_STATUS_LABELS[item.status] || item.status)}</span>${item.set_by_name ? ` <span class="ph-dash-note">by ${escapeHtml(item.set_by_name)}</span>` : ''}</p>
      ${item.status !== 'superseded' ? `<div class="ph-care-actions"><button type="button" class="ph-btn ph-btn-secondary ph-btn-sm" data-care-override="${escapeHtml(String(item.id))}">Set next date</button></div>` : ''}
    </article>`).join('');
  const missing = withoutReminder.map(appointment => `
    <li class="flex flex-wrap items-center justify-between gap-2">
      <span>${escapeHtml(getAppointmentReference(appointment))} · ${escapeHtml(displayValue(appointment.service_type, 'service'))} · ${escapeHtml(formatTableDate(appointment.appointment_date))}</span>
      <button type="button" class="ph-btn ph-btn-ghost ph-btn-sm" data-care-generate="${escapeHtml(String(appointment.id))}">Record care reminder</button>
    </li>`).join('');
  list.innerHTML = `
    ${cards ? `<div class="ph-care-list">${cards}</div>` : getAdminEmptyBlock('No care reminders yet', 'A reminder is recorded when one of this pet\'s appointments is marked Completed.')}
    ${missing ? `<div class="mt-4"><p class="ph-dash-note">Completed visits without a reminder (for example, completed before reminders existed):</p><ul class="ph-dash-stack mt-2">${missing}</ul></div>` : ''}`;
  list.dataset.petId = String(pet.id);
  list.recommendations = recommendations;
}

function openCareOverrideDialog(button) {
  const list = document.getElementById('adminPetCareList');
  const recommendation = asArray(list?.recommendations).find(item => String(item.id) === String(button.dataset.careOverride));
  if (!recommendation) return;
  const dialog = ensureBookingToolsDialog('careOverrideDialog', `
    <dialog id="careOverrideDialog" class="ph-dialog" aria-labelledby="careOverrideTitle" aria-describedby="careOverrideIntro">
      <form id="careOverrideForm" class="ph-dialog-content" novalidate>
        <div class="ph-dialog-head">
          <div>
            <h2 id="careOverrideTitle" class="ph-dialog-title">Set the next date</h2>
            <p id="careOverrideIntro" class="ph-dash-note"></p>
          </div>
          <button type="button" class="ph-btn ph-btn-ghost ph-btn-sm" data-close-dialog aria-label="Close without saving"><i class="ri-close-line" aria-hidden="true"></i></button>
        </div>
        <p id="careOverrideError" class="ph-field-error" role="alert" hidden></p>
        <div class="grid gap-4 md:grid-cols-2">
          <div class="ph-field"><label for="careOverrideFrom" class="ph-label">Suggested date</label><input id="careOverrideFrom" name="due_from" type="date" class="ph-input" required></div>
          <div class="ph-field"><label for="careOverrideTo" class="ph-label">Latest date (optional)</label><input id="careOverrideTo" name="due_to" type="date" class="ph-input"></div>
          <div class="ph-field md:col-span-2"><label for="careOverrideGuidance" class="ph-label">Type</label>
            <select id="careOverrideGuidance" name="guidance_type" class="ph-input">
              <option value="veterinarian_approved">Recommended by the clinic veterinarian for this pet</option>
              <option value="general">General care guidance</option>
            </select></div>
          <div class="ph-field md:col-span-2"><label for="careOverrideNote" class="ph-label">Note for the owner (optional)</label><textarea id="careOverrideNote" name="note" class="ph-input" rows="2" maxlength="300"></textarea></div>
        </div>
        <p class="ph-dash-note mt-3">The earlier suggestion is kept in the record as replaced. Owners always decide themselves whether to book.</p>
        <div class="ph-dialog-actions">
          <button type="button" class="ph-btn ph-btn-secondary" data-close-dialog>Cancel</button>
          <button type="submit" class="ph-btn ph-btn-primary">Save next date</button>
        </div>
      </form>
    </dialog>`);
  const form = document.getElementById('careOverrideForm');
  form.onsubmit = event => saveCareOverride(event, dialog);
  dialog.dataset.recommendationId = String(recommendation.id);
  dialog.returnFocusTo = button;
  document.getElementById('careOverrideIntro').textContent = `${recommendation.pet_name} · ${recommendation.service_name} on ${formatCareDate(recommendation.service_date)}.`;
  form.reset();
  form.elements.due_from.min = String(recommendation.service_date || '').slice(0, 10);
  form.elements.due_from.value = recommendation.due_from || '';
  form.elements.due_to.value = recommendation.due_to || '';
  setDialogError('careOverrideError', '');
  dialog.showModal();
  form.elements.due_from.focus();
}

async function saveCareOverride(event, dialog) {
  event.preventDefault();
  const form = event.currentTarget;
  if (isFormSubmitting(form)) return;
  const body = {
    due_from: form.elements.due_from.value,
    due_to: form.elements.due_to.value || '',
    guidance_type: form.elements.guidance_type.value,
    note: form.elements.note.value.trim()
  };
  if (!body.due_from) {
    setDialogError('careOverrideError', 'Choose the suggested date.');
    return;
  }
  if (body.due_to && body.due_to < body.due_from) {
    setDialogError('careOverrideError', 'The latest date must be on or after the suggested date.');
    return;
  }
  setFormSubmitting(form, true, 'Saving...', 'Save next date');
  try {
    const response = await fetchWithRetry(() => fetch(`${window.API_BASE_URL}/admin/care-recommendations/${encodeURIComponent(dialog.dataset.recommendationId)}/override${getAdminUserIdQuery()}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success !== true) {
      setDialogError('careOverrideError', data.error || `Could not save the next date (${response.status}).`);
      return;
    }
    dialog.close();
    const pet = getPetById(document.getElementById('adminPetCareSection')?.dataset.petId);
    if (pet) await loadAdminPetCareReminders(pet);
    showAdminStatus('success', 'Next date saved. The owner sees it in their care reminders.');
  } catch (error) {
    setDialogError('careOverrideError', error.message || 'Could not save the next date.');
  } finally {
    setFormSubmitting(form, false, 'Saving...', 'Save next date');
  }
}

async function generateCareReminder(button) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    const response = await fetchWithRetry(() => fetch(`${window.API_BASE_URL}/admin/appointments/${encodeURIComponent(button.dataset.careGenerate)}/care-recommendation${getAdminUserIdQuery()}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success !== true) throw new Error(data.error || `Could not record the reminder (${response.status}).`);
    const pet = getPetById(document.getElementById('adminPetCareSection')?.dataset.petId);
    if (pet) await loadAdminPetCareReminders(pet);
    showAdminStatus('success', data.created ? 'Care reminder recorded for that visit.' : 'That visit already had a care reminder.');
  } catch (error) {
    showAdminStatus('error', error.message || 'Could not record the reminder.');
    button.disabled = false;
  }
}

document.addEventListener('click', event => {
  const groupCancel = event.target.closest('[data-group-cancel]');
  if (groupCancel) return openGroupCancelDialog(groupCancel);
  const reschedule = event.target.closest('[data-appointment-reschedule]');
  if (reschedule) return openRescheduleDialog(reschedule);
  const override = event.target.closest('[data-care-override]');
  if (override) return openCareOverrideDialog(override);
  const generate = event.target.closest('[data-care-generate]');
  if (generate) return generateCareReminder(generate);
  return undefined;
});
