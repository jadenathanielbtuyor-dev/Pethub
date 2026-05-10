// PetHub Admin Pets Management - API-based

document.addEventListener('DOMContentLoaded', () => {
  initializePetsManagement();
});

function initializePetsManagement() {
  if (typeof window.API_BASE_URL === 'undefined') {
    console.error('API_BASE_URL not found. Ensure core/api.js is loaded first.');
    return;
  }

  const user = getUser();

  if (!isLoggedIn() || !user || String(user.role || '').toLowerCase() !== 'admin') {
    redirectToLogin();
    return;
  }

  loadPets();
}

async function loadPets() {
  const table = document.getElementById('petsTable');
  if (table) {
    table.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-gray-500">Loading pets...</td></tr>';
  }

  try {
    const user = getUser();
    const query = user && user.id ? `?user_id=${encodeURIComponent(user.id)}` : '';
    const response = await fetch(`${window.API_BASE_URL}/admin/dashboard/pets${query}`);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(errorData.error || `Failed to load pets (${response.status})`);
    }

    const data = await response.json();
    await loadAndDisplayPets(data.pets || []);
  } catch (error) {
    console.error('Error loading pets:', error);
    if (table) {
      table.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-red-500">${escapeHtml(error.message)}</td></tr>`;
    }
  }
}

async function loadAndDisplayPets(pets) {
  try {
    const user = getUser();
    const query = user && user.id ? `?user_id=${encodeURIComponent(user.id)}` : '';
    const usersResponse = await fetch(`${window.API_BASE_URL}/admin/dashboard/users${query}`);

    if (!usersResponse.ok) {
      throw new Error(`Failed to load users (${usersResponse.status})`);
    }

    const usersData = await usersResponse.json();
    displayPetsTable(pets, usersData.users || []);
  } catch (error) {
    console.error('Error loading users:', error);
    displayPetsTable(pets, []);
  }
}

function displayPetsTable(pets, users) {
  const table = document.getElementById('petsTable');
  if (!table) return;

  if (!pets || pets.length === 0) {
    table.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-gray-500">No pets found</td></tr>';
    return;
  }

  table.innerHTML = pets.map(pet => {
    const owner = users.find(user => String(user.id) === String(pet.user_id));
    const ownerName = pet.owner_name || (owner ? owner.fullname : null);
    const latestRecord = getLatestMedicalRecordText(pet);
    const latestRecordDate = pet.latest_medical_record_date ? formatDate(pet.latest_medical_record_date) : '';

    return `
      <tr class="border-t hover:bg-gray-50 transition-colors">
        <td class="p-4 font-semibold">${escapeHtml(pet.name || 'N/A')}</td>
        <td class="p-4">${getAnimalEmoji(pet.species)} ${escapeHtml(pet.species || 'N/A')}</td>
        <td class="p-4">${escapeHtml(pet.breed || 'N/A')}</td>
        <td class="p-4">${escapeHtml(pet.age || pet.age === 0 ? `${pet.age} years` : 'N/A')}</td>
        <td class="p-4">${escapeHtml(ownerName || 'Unknown')}</td>
        <td class="p-4">
          <p class="max-w-xs text-sm text-slate-700">${escapeHtml(latestRecord)}</p>
          ${latestRecordDate ? `<p class="mt-1 text-xs text-slate-500">${escapeHtml(latestRecordDate)}</p>` : ''}
        </td>
      </tr>
    `;
  }).join('');
}

function getLatestMedicalRecordText(pet) {
  if (!pet || !pet.latest_medical_record_summary) return 'No medical records yet';
  return String(pet.latest_medical_record_summary);
}
