// PetHub Admin Users Management - API-based

document.addEventListener('DOMContentLoaded', () => {
  initializeUsersManagement();
});

/**
 * Initialize users management page
 */
function initializeUsersManagement() {
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
  
  loadUsers();
}

/**
 * Load all users from backend
 */
async function loadUsers() {
  const table = document.getElementById('usersTable');
  if (table) {
    table.innerHTML = '<tr><td colspan="4" class="p-4 text-center text-gray-500">Loading users...</td></tr>';
  }

  try {
    const user = getUser();
    const query = user && user.id ? `?user_id=${encodeURIComponent(user.id)}` : '';
    const response = await fetch(`${window.API_BASE_URL}/admin/dashboard/users${query}`);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(errorData.error || `Failed to load users (${response.status})`);
    }
    
    const data = await response.json();
    displayUsersTable(data.users || []);

  } catch (error) {
    console.error('Error loading users:', error);
    if (table) {
      table.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-red-500">${escapeHtml(error.message || 'Unable to load users.')}</td></tr>`;
    }
  }
}

/**
 * Display users in table
 */
function displayUsersTable(users) {
  const table = document.getElementById('usersTable');
  if (!table) return;
  
  if (!users || users.length === 0) {
    table.innerHTML = '<tr><td colspan="4" class="p-4 text-center text-gray-500">No users found</td></tr>';
    return;
  }

  table.innerHTML = users.map(user => `
    <tr class="border-t hover:bg-gray-50 transition-colors">
      <td class="p-4 font-semibold">${escapeHtml(user.fullname || 'Name not provided')}</td>
      <td class="p-4">${escapeHtml(user.email || 'Email not provided')}</td>
      <td class="p-4">
        <span class="px-3 py-1 rounded text-sm font-semibold ${getRoleBadgeClass(user.role)}">
          ${escapeHtml(user.role || 'Role not recorded')}
        </span>
      </td>
      <td class="p-4 text-xs text-gray-500">${escapeHtml(formatDate(user.created_at))}</td>
    </tr>
  `).join('');
}

/**
 * Get CSS class for role badge
 */
function getRoleBadgeClass(role) {
  if (role === 'admin') {
    return 'bg-purple-100 text-purple-700';
  }
  return 'bg-blue-100 text-blue-700';
}
