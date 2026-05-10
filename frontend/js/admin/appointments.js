// PetHub Admin Appointments Management - API-based

document.addEventListener('DOMContentLoaded', () => {
  initializeAppointmentsManagement();
});

let adminAppointmentsData = [];
let adminPetsData = [];
let adminPetsLoadPromise = null;

function getAdminUserIdQuery() {
  const user = getUser();
  return user && user.id ? `?user_id=${encodeURIComponent(user.id)}` : '';
}

function getCurrentAdminUserId() {
  const user = getUser();
  return user && user.id ? String(user.id) : '';
}

function getAppointmentActionButtonClass(type) {
  const baseClasses = 'inline-flex items-center justify-center rounded px-3 py-1 text-sm font-semibold shadow-sm transition';
  const classes = {
    danger: 'bg-red-50 text-red-700 hover:bg-red-100',
    success: 'bg-green-50 text-green-700 hover:bg-green-100'
  };

  return `${baseClasses} ${classes[type] || classes.success}`;
}

function setAppointmentActionGroupLoading(button, isLoading, loadingText, defaultText) {
  if (!button) return;

  const actionButtons = Array.from(button.closest('div')?.querySelectorAll('button') || [button]);
  actionButtons.forEach(actionButton => {
    if (actionButton === button) {
      updateButtonState(actionButton, isLoading, loadingText, defaultText);
    } else {
      actionButton.disabled = isLoading;
      actionButton.classList.toggle('is-peer-disabled', isLoading);
    }
  });
}

/**
 * Initialize admin appointments page
 */
function initializeAppointmentsManagement() {
  // Verify API is available
  if (typeof window.API_BASE_URL === 'undefined') {
    console.error('API_BASE_URL not found. Ensure core/api.js is loaded first.');
    return;
  }

  const user = getUser();
  
  if (!isLoggedIn() || !user || String(user.role || '').toLowerCase() !== 'admin') {
    redirectToLogin();
    return;
  }
  
  loadAppointments();
}

/**
 * Load all appointments from backend
 */
async function loadAppointments() {
  const table = document.getElementById('appointmentsTable');
  if (table) {
    table.innerHTML = '<tr><td colspan="8" class="p-4 text-center text-gray-500">Loading appointments...</td></tr>';
  }

  try {
    const query = getAdminUserIdQuery();
    if (!query) {
      throw new Error('Admin user ID not found. Please log in again.');
    }

    const response = await fetch(`${window.API_BASE_URL}/admin/dashboard/appointments${query}`);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(errorData.error || `Failed to load appointments (${response.status})`);
    }
    
    const data = await response.json();
    adminAppointmentsData = Array.isArray(data.appointments) ? data.appointments : [];
    try {
      await loadAdminPetsForMedicalRecords();
    } catch (petsError) {
      console.warn('Medical record actions hidden because pets could not be loaded:', petsError);
      adminPetsData = [];
    }
    displayAppointmentsTable(adminAppointmentsData);
    return true;
  } catch (error) {
    console.error('Error loading appointments:', error);
    adminAppointmentsData = [];
    if (table) {
      table.innerHTML = `<tr><td colspan="8" class="p-4 text-center text-red-500">${escapeHtml(error.message || 'Unable to load appointments.')}</td></tr>`;
    }
    return false;
  }
}

/**
 * Display appointments in table
 */
function displayAppointmentsTable(appointments) {
  const table = document.getElementById('appointmentsTable');
  if (!table) return;
  
  if (!appointments || appointments.length === 0) {
    table.innerHTML = '<tr><td colspan="8" class="p-4 text-center text-gray-500">No appointments found</td></tr>';
    return;
  }

  table.innerHTML = appointments.map(apt => {
    const handledBy = getHandledByLabel(apt);
    const status = getAppointmentStatus(apt.status);
    return `
      <tr class="border-t bg-white hover:bg-slate-50 transition-colors">
        <td class="p-4 font-medium text-slate-900">${escapeHtml(apt.pet_name || 'N/A')}</td>
        <td class="p-4 text-slate-700">${escapeHtml(apt.service_type || 'N/A')}</td>
        <td class="p-4 text-slate-700">${escapeHtml(getAppointmentDurationLabel(apt))}</td>
        <td class="p-4 text-slate-700">${escapeHtml(getAppointmentDateDisplay(apt.appointment_date))}</td>
        <td class="p-4 text-slate-700">${escapeHtml(getAppointmentTimeDisplay(apt))}</td>
        <td class="p-4">
          <span class="inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold ${getStatusBadgeClass(status)}">
            ${escapeHtml(status)}
          </span>
        </td>
        <td class="p-4 text-slate-700">${handledBy ? escapeHtml(handledBy) : '<span class="text-slate-400">-</span>'}</td>
        <td class="p-4">
          ${renderAppointmentActions(status, apt)}
        </td>
      </tr>
    `;
  }).join('');
}

function getHandledByLabel(appointment) {
  if (!appointment || !appointment.handled_by || !appointment.handled_by_name) return '';
  return appointment.handled_by_name;
}

function getAppointmentStatus(status) {
  const normalizedStatus = String(status || 'Pending').toLowerCase();
  const statusMap = {
    pending: 'Pending',
    approved: 'Approved',
    completed: 'Completed',
    cancelled: 'Cancelled'
  };
  return statusMap[normalizedStatus] || String(status || 'Pending');
}

function getAppointmentDurationMinutes(appointment) {
  const duration = Number(appointment?.estimated_duration_minutes);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function getAppointmentDurationLabel(appointment) {
  const minutes = getAppointmentDurationMinutes(appointment);
  if (!Number.isFinite(minutes)) return 'N/A';

  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }

  return `${minutes} minutes`;
}

function getAppointmentDateDisplay(dateValue) {
  const match = String(dateValue || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return 'N/A';

  const appointmentDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(appointmentDate.getTime())) return 'N/A';
  return appointmentDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

function getAppointmentTimeDisplay(appointment) {
  const rawTime = String(appointment?.appointment_time || '').trim();
  const match = rawTime.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  const durationMinutes = getAppointmentDurationMinutes(appointment);

  if (!match || !Number.isFinite(durationMinutes)) {
    return 'N/A';
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
    return 'N/A';
  }

  const startTime = new Date(2000, 0, 1, hours, minutes, seconds, 0);
  const endTime = new Date(startTime.getTime() + durationMinutes * 60000);
  const formatOptions = { hour: 'numeric', minute: '2-digit' };

  return `${startTime.toLocaleTimeString('en-US', formatOptions)} - ${endTime.toLocaleTimeString('en-US', formatOptions)}`;
}

function escapeInlineHandlerValue(value) {
  return escapeHtml(String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n'));
}

function hasMedicalRecordCreateContext(appointment) {
  if (!getCurrentAdminUserId()) return false;
  if (!appointment || !appointment.id || !appointment.user_id) return false;
  return getAppointmentOwnerPetsForMedicalRecord(appointment, adminPetsData).length > 0;
}

function renderAppointmentActions(status, appointment) {
  const appointmentId = appointment?.id;
  if (!appointmentId) {
    return '<span class="text-xs text-gray-500">-</span>';
  }

  const isPending = status === 'Pending';
  const isApproved = status === 'Approved';
  const isCompleted = status === 'Completed';
  const isFinal = isCompleted || status === 'Cancelled';
  const safeAppointmentId = escapeInlineHandlerValue(appointmentId);

  if (isCompleted && hasMedicalRecordCreateContext(appointment)) {
    return `
      <div class="flex flex-wrap gap-2">
        <button onclick="openMedicalRecordForm(this, '${safeAppointmentId}')" class="${getAppointmentActionButtonClass('success')}">
          Add Medical Record
        </button>
      </div>
    `;
  }

  if (isFinal) {
    return '<span class="text-xs text-gray-500">No action</span>';
  }

  return `
    <div class="flex flex-wrap gap-2">
      ${isPending ? `
        <button onclick="updateAppointmentStatus(this, '${safeAppointmentId}', 'Approved')" class="${getAppointmentActionButtonClass('success')}">
          Approve
        </button>
      ` : ''}
      ${isApproved ? `
        <button onclick="updateAppointmentStatus(this, '${safeAppointmentId}', 'Completed')" class="${getAppointmentActionButtonClass('success')}">
          Complete
        </button>
      ` : ''}
      ${(isPending || isApproved) ? `
        <button onclick="updateAppointmentStatus(this, '${safeAppointmentId}', 'Cancelled')" class="${getAppointmentActionButtonClass('danger')}">
          Cancel
        </button>
      ` : ''}
    </div>
  `;
}

function getMedicalRecordAppointment(appointmentId) {
  const id = String(appointmentId || '');
  return adminAppointmentsData.find(appointment => String(appointment.id) === id) || null;
}

function getLocalDateInputValue() {
  const now = new Date();
  const timezoneOffsetMs = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - timezoneOffsetMs).toISOString().slice(0, 10);
}

async function loadAdminPetsForMedicalRecords() {
  if (adminPetsData.length > 0) return adminPetsData;
  if (adminPetsLoadPromise) return adminPetsLoadPromise;

  const query = getAdminUserIdQuery();
  if (!query) {
    throw new Error('Admin user ID not found. Please log in again.');
  }

  adminPetsLoadPromise = fetch(`${window.API_BASE_URL}/admin/dashboard/pets${query}`)
    .then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        throw new Error(data.error || `Failed to load pets (${response.status})`);
      }
      adminPetsData = Array.isArray(data.pets) ? data.pets : [];
      return adminPetsData;
    })
    .finally(() => {
      adminPetsLoadPromise = null;
    });

  return adminPetsLoadPromise;
}

function getAppointmentOwnerPetsForMedicalRecord(appointment, pets) {
  const ownerId = String(appointment?.user_id || '').trim();
  if (!ownerId) return [];

  return (Array.isArray(pets) ? pets : [])
    .filter(pet => String(pet?.user_id || '').trim() === ownerId);
}

function getConfirmedAppointmentPetId(appointment, ownerPets) {
  const appointmentPetId = String(appointment?.pet_id || '').trim();
  if (!appointmentPetId) return '';

  const confirmedPet = (Array.isArray(ownerPets) ? ownerPets : [])
    .find(pet => String(pet?.id || '').trim() === appointmentPetId);
  return confirmedPet ? appointmentPetId : '';
}

function getMedicalRecordPetOptionLabel(pet) {
  const parts = [
    pet?.name || 'Unnamed pet',
    pet?.species,
    pet?.breed
  ];

  return parts.map(part => String(part || '').trim()).filter(Boolean).join(' - ');
}

function populateMedicalRecordPetSelect(select, ownerPets, selectedPetId = '') {
  if (!select) return;

  const pets = Array.isArray(ownerPets) ? ownerPets : [];
  const selectedId = String(selectedPetId || '').trim();
  const options = [
    '<option value="">Select pet</option>',
    ...pets.map(pet => {
      const id = String(pet?.id || '').trim();
      const selected = id && id === selectedId ? ' selected' : '';
      return `<option value="${escapeHtml(id)}"${selected}>${escapeHtml(getMedicalRecordPetOptionLabel(pet))}</option>`;
    })
  ];

  select.innerHTML = options.join('');
  select.disabled = pets.length === 0;
  select.value = pets.some(pet => String(pet?.id || '').trim() === selectedId) ? selectedId : '';
}

function getPetById(petId) {
  const id = String(petId || '').trim();
  if (!id) return null;
  return adminPetsData.find(pet => String(pet?.id || '').trim() === id) || null;
}

function updateMedicalRecordSaveState(form, syncError = true) {
  if (!form) return;

  const petId = String(form.elements?.pet_id?.value || '').trim();
  const recordDate = String(form.elements?.record_date?.value || '').trim();
  const adminId = getCurrentAdminUserId();
  const selectedPet = getPetById(petId);
  const saveButton = form.querySelector('button[type="submit"]');
  const canSave = Boolean(selectedPet && recordDate && adminId);

  if (saveButton) {
    saveButton.disabled = !canSave || isFormSubmitting(form);
    saveButton.classList.toggle('opacity-60', !canSave);
    saveButton.classList.toggle('cursor-not-allowed', !canSave);
  }

  if (syncError) {
    if (!petId || !selectedPet) {
      setMedicalRecordFormError('Select a valid pet before saving.');
    } else if (!recordDate) {
      setMedicalRecordFormError('Record date is required.');
    } else if (!adminId) {
      setMedicalRecordFormError('Admin user ID not found. Please log in again.');
    } else {
      setMedicalRecordFormError('');
    }
  }
}

function ensureMedicalRecordModal() {
  let modal = document.getElementById('adminMedicalRecordModal');
  if (modal) return modal;

  document.body.insertAdjacentHTML('beforeend', `
    <div id="adminMedicalRecordModal" class="fixed inset-0 z-50 hidden items-center justify-center bg-slate-950/40 px-4 py-6">
      <div class="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl">
        <div class="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 class="text-lg font-bold text-slate-900">Add Medical Record</h2>
            <p id="adminMedicalRecordContext" class="mt-1 text-sm text-slate-500"></p>
          </div>
          <button type="button" onclick="closeMedicalRecordForm()" class="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200" aria-label="Close medical record form">
            <i class="ri-close-line text-lg"></i>
          </button>
        </div>

        <form id="adminMedicalRecordForm" class="space-y-4">
          <p id="adminMedicalRecordError" class="hidden rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"></p>

          <div>
            <label for="adminMedicalRecordPetId" class="mb-1 block text-sm font-semibold text-slate-700">Pet</label>
            <select id="adminMedicalRecordPetId" name="pet_id" required class="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-orange-400 focus:outline-none">
              <option value="">Select pet</option>
            </select>
            <p id="adminMedicalRecordRequestedPet" class="mt-1 text-xs text-slate-500"></p>
          </div>

          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label for="adminMedicalRecordWeight" class="mb-1 block text-sm font-semibold text-slate-700">Weight</label>
              <input id="adminMedicalRecordWeight" name="weight" type="number" min="0" step="0.01" required class="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-orange-400 focus:outline-none">
            </div>
            <div>
              <label for="adminMedicalRecordDate" class="mb-1 block text-sm font-semibold text-slate-700">Record Date</label>
              <input id="adminMedicalRecordDate" name="record_date" type="date" required class="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-orange-400 focus:outline-none">
            </div>
            <div>
              <label for="adminMedicalRecordVaccination" class="mb-1 block text-sm font-semibold text-slate-700">Vaccination Status</label>
              <select id="adminMedicalRecordVaccination" name="vaccination_status" required class="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-orange-400 focus:outline-none">
                <option value="" disabled selected>Select status</option>
                <option value="Up to date">Up to date</option>
                <option value="Due soon">Due soon</option>
                <option value="Overdue">Overdue</option>
                <option value="Not applicable">Not applicable</option>
              </select>
            </div>
          </div>

          <div>
            <label for="adminMedicalRecordTreatment" class="mb-1 block text-sm font-semibold text-slate-700">Treatment</label>
            <input id="adminMedicalRecordTreatment" name="treatment" type="text" required class="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-orange-400 focus:outline-none">
          </div>

          <div>
            <label for="adminMedicalRecordNotes" class="mb-1 block text-sm font-semibold text-slate-700">Medical Notes</label>
            <textarea id="adminMedicalRecordNotes" name="medical_notes" rows="4" required class="w-full resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-orange-400 focus:outline-none"></textarea>
          </div>

          <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onclick="closeMedicalRecordForm()" class="inline-flex items-center justify-center rounded-lg bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-200">Cancel</button>
            <button type="submit" class="inline-flex items-center justify-center rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600">Save Record</button>
          </div>
        </form>
      </div>
    </div>
  `);

  modal = document.getElementById('adminMedicalRecordModal');
  const form = document.getElementById('adminMedicalRecordForm');
  if (form) {
    form.addEventListener('submit', submitMedicalRecordForm);
    form.elements.pet_id?.addEventListener('change', () => updateMedicalRecordSaveState(form));
    form.elements.record_date?.addEventListener('input', () => updateMedicalRecordSaveState(form));
  }

  modal?.addEventListener('click', event => {
    if (event.target === modal) {
      closeMedicalRecordForm();
    }
  });

  return modal;
}

function setMedicalRecordFormError(message) {
  const errorElement = document.getElementById('adminMedicalRecordError');
  if (!errorElement) return;

  if (!message) {
    errorElement.textContent = '';
    errorElement.classList.add('hidden');
    return;
  }

  errorElement.textContent = message;
  errorElement.classList.remove('hidden');
}

function getMedicalRecordContextLabel(appointment) {
  const parts = [
    appointment?.pet_name || 'Pet not listed',
    appointment?.owner_fullname || 'Unknown owner',
    formatDate(appointment?.appointment_date)
  ];
  return parts.map(part => String(part || '').trim()).filter(Boolean).join(' - ');
}

async function openMedicalRecordForm(button, appointmentId) {
  if (button?.dataset?.loading === 'true') return;

  const appointment = getMedicalRecordAppointment(appointmentId);
  if (!appointment || getAppointmentStatus(appointment.status) !== 'Completed') {
    showError('Medical records can only be added after an appointment is completed.');
    return;
  }

  const originalText = button?.textContent?.trim() || 'Add Medical Record';
  try {
    setAppointmentActionGroupLoading(button, true, 'Loading...', originalText);
    const pets = await loadAdminPetsForMedicalRecords();
    const ownerPets = getAppointmentOwnerPetsForMedicalRecord(appointment, pets);
    const selectedPetId = getConfirmedAppointmentPetId(appointment, ownerPets);

    const modal = ensureMedicalRecordModal();
    const form = document.getElementById('adminMedicalRecordForm');
    const context = document.getElementById('adminMedicalRecordContext');
    const requestedPet = document.getElementById('adminMedicalRecordRequestedPet');
    const recordDate = getLocalDateInputValue();

    if (form) {
      form.reset();
      form.dataset.submitting = 'false';
      form.removeAttribute('aria-busy');
      populateMedicalRecordPetSelect(form.elements.pet_id, ownerPets, selectedPetId);
      form.elements.record_date.value = recordDate;
      updateMedicalRecordSaveState(form);
    }

    if (context) context.textContent = getMedicalRecordContextLabel(appointment);
    if (requestedPet) requestedPet.textContent = `Requested pet: ${appointment.pet_name || 'Pet not listed'}`;
    if (modal) {
      modal.dataset.appointmentId = String(appointmentId || '');
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      requestAnimationFrame(() => {
        const focusTarget = selectedPetId
          ? document.getElementById('adminMedicalRecordWeight')
          : document.getElementById('adminMedicalRecordPetId');
        focusTarget?.focus();
      });
    }
  } catch (error) {
    console.error('Error opening medical record form:', error);
    showError(error.message || 'Could not open medical record form.');
  } finally {
    setAppointmentActionGroupLoading(button, false, 'Loading...', originalText);
  }
}

function closeMedicalRecordForm(force = false) {
  const modal = document.getElementById('adminMedicalRecordModal');
  const form = document.getElementById('adminMedicalRecordForm');
  if (!force && isFormSubmitting(form)) return;

  modal?.classList.add('hidden');
  modal?.classList.remove('flex');
  if (modal) delete modal.dataset.appointmentId;
}

function getMedicalRecordFormPayload(form, appointmentId = '') {
  const formData = new FormData(form);
  const adminId = getCurrentAdminUserId();
  const payload = {
    user_id: adminId,
    pet_id: String(formData.get('pet_id') || '').trim(),
    record_date: String(formData.get('record_date') || '').trim(),
    created_by: adminId
  };

  ['weight', 'vaccination_status', 'treatment', 'medical_notes'].forEach(field => {
    const value = String(formData.get(field) || '').trim();
    if (value) payload[field] = value;
  });

  if (!payload.pet_id) {
    throw new Error('Select a valid pet before saving.');
  }

  if (!getPetById(payload.pet_id)) {
    throw new Error('Select a valid pet before saving.');
  }

  if (!payload.record_date) {
    throw new Error('Record date is required.');
  }

  if (!payload.user_id) {
    throw new Error('Admin user ID not found. Please log in again.');
  }

  if (appointmentId) {
    payload.appointment_id = String(appointmentId);
  }

  if (!payload.weight || !payload.vaccination_status || !payload.treatment || !payload.medical_notes) {
    throw new Error('Weight, vaccination status, treatment, and medical notes are required.');
  }

  const numericWeight = Number(payload.weight);
  if (!Number.isFinite(numericWeight) || numericWeight < 0) {
    throw new Error('Weight must be a valid non-negative number.');
  }

  return payload;
}

async function submitMedicalRecordForm(event) {
  event.preventDefault();

  const form = event.currentTarget;
  if (isFormSubmitting(form)) return;

  const modal = document.getElementById('adminMedicalRecordModal');
  const appointmentId = modal?.dataset?.appointmentId;
  const appointment = getMedicalRecordAppointment(appointmentId);

  try {
    if (!appointment || getAppointmentStatus(appointment.status) !== 'Completed') {
      throw new Error('Medical records can only be added after an appointment is completed.');
    }

    const payload = getMedicalRecordFormPayload(form, appointmentId);
    const adminQuery = getAdminUserIdQuery();
    const adminId = getCurrentAdminUserId();
    if (!adminQuery || !adminId) {
      throw new Error('Admin user ID not found. Please log in again.');
    }

    setMedicalRecordFormError('');
    setFormSubmitting(form, true, 'Saving...', 'Save Record');

    const response = await fetch(`${window.API_BASE_URL}/admin/dashboard/medical-records/create${adminQuery}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-ID': adminId },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(data.error || 'Could not create medical record.');
    }

    if (!data.record) {
      throw new Error('Medical record save succeeded but no record was returned.');
    }

    const refreshed = await loadAppointments();
    closeMedicalRecordForm(true);
    if (refreshed) {
      showSuccess('Medical record added.');
    } else {
      showError('Medical record saved, but the appointments list could not refresh. Please refresh.');
    }
  } catch (error) {
    console.error('Error creating medical record:', error);
    setMedicalRecordFormError(error.message || 'Could not create medical record.');
  } finally {
    setFormSubmitting(form, false, 'Saving...', 'Save Record');
    updateMedicalRecordSaveState(form, false);
  }
}

/**
 * Get CSS class for status badge
 */
function getStatusBadgeClass(status) {
  const classes = {
    'Pending': 'bg-yellow-50 text-yellow-600',
    'Approved': 'bg-green-50 text-green-700',
    'Completed': 'bg-green-50 text-green-700',
    'Cancelled': 'bg-red-50 text-red-700'
  };
  return classes[status] || 'bg-slate-100 text-slate-700';
}

/**
 * Update appointment status via API
 */
async function updateAppointmentStatus(button, appointmentId, newStatus) {
  if (button?.dataset?.loading === 'true') return;

  if (!requireSecondClick(button, {
    key: `appointment-status:${appointmentId}:${newStatus}`,
    message: 'Click again to confirm'
  })) {
    return;
  }

  const originalText = button?.textContent?.trim() || 'Update';
  try {
    setAppointmentActionGroupLoading(button, true, 'Updating...', originalText);

    if (!appointmentId) {
      throw new Error('Appointment ID is required.');
    }

    const adminQuery = getAdminUserIdQuery();
    if (!adminQuery) {
      throw new Error('Admin user ID not found. Please log in again.');
    }

    const response = await fetch(`${window.API_BASE_URL}/admin/dashboard/appointment-status${adminQuery}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: appointmentId,
        status: newStatus
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.success === false) {
      throw new Error(data.error || 'Could not update appointment.');
    }

    if (!data.appointment) {
      throw new Error('Appointment update succeeded but no appointment was returned');
    }

    await loadAppointments();
    showSuccess(getAppointmentStatusFeedback(newStatus));
  } catch (error) {
    console.error('Error updating appointment:', error);
    setAppointmentActionGroupLoading(button, false, 'Updating...', originalText);
    showError(error.message || 'Could not update appointment.');
  }
}

function getAppointmentStatusFeedback(status) {
  const messages = {
    Approved: 'Appointment approved.',
    Completed: 'Appointment completed.',
    Cancelled: 'Appointment cancelled.'
  };
  return messages[status] || 'Appointment updated.';
}

window.openMedicalRecordForm = openMedicalRecordForm;
window.closeMedicalRecordForm = closeMedicalRecordForm;
window.updateAppointmentStatus = updateAppointmentStatus;
