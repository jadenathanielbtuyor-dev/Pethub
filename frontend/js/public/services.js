// Public services page: the persisted clinic catalog is the only source of current service details.
(function initializePublicServices(root) {
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function renderServices(container, services) {
    if (!services.length) {
      container.innerHTML = '<p class="ph-dash-note" role="status">The clinic has not published any services yet. Contact the clinic for current information.</p>';
      return;
    }

    const groups = new Map();
    services.forEach(service => {
      const category = String(service.category_label || service.category || 'Services');
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(service);
    });

    container.innerHTML = [...groups.entries()].map(([category, entries]) => `
      <section class="ph-section" aria-labelledby="service-group-${escapeHtml(category.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}">
        <div class="ph-container">
          <h2 id="service-group-${escapeHtml(category.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}" class="ph-title">${escapeHtml(category)}</h2>
          <div class="ph-card-grid ph-card-grid-3 mt-6">
            ${entries.map(service => {
              const species = Array.isArray(service.species) ? service.species : [];
              const serviceQuery = `service=${encodeURIComponent(String(service.id || service.name || ''))}`;
              const user = typeof root.getUser === 'function' ? root.getUser() : null;
              const signedInCustomer = typeof root.isLoggedIn === 'function' && root.isLoggedIn()
                && String(user?.role || '').toLowerCase() !== 'admin';
              const bookingUrl = signedInCustomer
                ? `../../pages/user/appointments.html?${serviceQuery}`
                : `../../pages/auth/login.html?next=appointments&${serviceQuery}`;
              const action = service.bookable === true
                ? `<a href="${escapeHtml(bookingUrl)}" class="ph-link-arrow" data-book-link>Book this service <i class="ri-arrow-right-line" aria-hidden="true"></i></a>`
                // The server's unavailable_reason is written for the clinic (missing settings); customers get the plain fact and a next step
                : '<span class="ph-dash-muted">Not available for online booking right now.</span> <a href="../../pages/public/contact.html" class="ph-link-arrow">Contact the clinic</a>';
              const duration = Number.isInteger(service.duration_minutes) && service.duration_minutes > 0
                ? `<p class="mt-2 text-sm text-slate-600">Confirmed duration: ${escapeHtml(service.duration_minutes)} minutes</p>`
                : '';
              return `<article class="ph-card">
                <span class="ph-icon"><i class="${service.category === 'veterinary' ? 'ri-stethoscope-line' : 'ri-scissors-cut-line'}" aria-hidden="true"></i></span>
                <h3 class="ph-card-title">${escapeHtml(service.name)}</h3>
                <p class="ph-card-text">${escapeHtml(service.description || '')}</p>
                <p class="mt-3 text-sm text-slate-600">${species.length ? `For ${escapeHtml(species.map(name => `${name.toLowerCase()}s`).join(' and '))}` : 'Ask the clinic which pets this service is for.'}</p>
                ${duration}
                <div class="mt-5">${action}</div>
              </article>`;
            }).join('')}
          </div>
        </div>
      </section>
    `).join('');
  }

  async function loadPublicServices() {
    const container = document.getElementById('publicServiceCatalog');
    if (!container || !root.API_BASE_URL) return;
    try {
      const response = await fetch(`${root.API_BASE_URL}/appointments/services`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success !== true || !Array.isArray(data.services)) {
        throw new Error(data.error || 'The service list could not be loaded.');
      }
      renderServices(container, data.services);
    } catch (error) {
      container.innerHTML = '<p class="ph-dash-error-text" role="alert">The current service list is unavailable. Please contact the clinic for service information.</p>';
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', loadPublicServices);
  }
})(typeof window !== 'undefined' ? window : globalThis);
