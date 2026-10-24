// PetHub dashboard shell: the section navigation shared by the Pet Owner Dashboard and the Admin Dashboard.
// - Which dashboard and section: <body data-dashboard="owner|admin" data-dashboard-section="...">; the navigation is
//   rendered in place of <div id="dashboardNavRoot"> (styles: .ph-dash-* in assets/css/input.css).
// - Pet Owner sections are separate pages (pages/user/dashboard.html, pets.html, appointments.html, health.html).
//   Admin sections are views of pages/admin/dashboard.html (#overview, #appointments, #records, #system), with the
//   breed catalog managed on its own focused page.
//   js/admin/dashboard.js shows through window.showAdminView().
// - From 1024px the navigation is a sidebar beside the content; below that it is a bar of four links that stays at the
//   top of the screen. It is never hidden and never covers the page.
// - Navigation only. Every page checks sign-in itself, and the server checks every request (middleware/requireAuth.js
//   matches the signed token to the account; /admin routes also re-read the admin role from the database), so hiding a
//   link is never what protects an operation.
(function initDashboardShell() {
  const DASHBOARDS = {
    owner: {
      label: 'Pet Owner Dashboard',
      sections: [
        { id: 'overview', href: 'dashboard.html', icon: 'ri-home-5-line', label: 'Overview', short: 'Overview' },
        { id: 'pets', href: 'pets.html', icon: 'ri-bear-smile-line', label: 'My Pets', short: 'My Pets' },
        { id: 'appointments', href: 'appointments.html', icon: 'ri-calendar-check-line', label: 'Appointments', short: 'Appointments' },
        { id: 'health', href: 'health.html', icon: 'ri-heart-pulse-line', label: 'Pet Health & AI Assistant', short: 'Health & AI' }
      ]
    },
    admin: {
      label: 'Admin Dashboard',
      sections: [
        { id: 'overview', href: '#overview', icon: 'ri-dashboard-line', label: 'Overview', short: 'Overview' },
        { id: 'appointments', href: '#appointments', icon: 'ri-calendar-check-line', label: 'Appointment Management', short: 'Appointments' },
        { id: 'records', href: '#records', icon: 'ri-health-book-line', label: 'Pet Owners & Records', short: 'Owners' },
        { id: 'system', href: '#system', icon: 'ri-settings-4-line', label: 'System Management', short: 'System' },
        { id: 'breeds', href: 'breeds.html', icon: 'ri-list-check-2', label: 'Breed Catalog', short: 'Breeds' }
      ]
    }
  };

  const escape = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  function getDashboard() {
    return DASHBOARDS[document.body.dataset.dashboard] || DASHBOARDS.owner;
  }

  function getAccountName() {
    const user = typeof getUser === 'function' ? getUser() : null;
    return user && String(user.fullname || '').trim() ? String(user.fullname).trim() : 'Your account';
  }

  function renderNavigation(root) {
    const dashboard = getDashboard();
    const active = document.body.dataset.dashboardSection || dashboard.sections[0].id;
    // "#..." sections are views of pages/admin/dashboard.html; from another admin page (breeds.html) they link there
    const activeSection = dashboard.sections.find(section => section.id === active);
    const viewsOnThisPage = !activeSection || activeSection.href.startsWith('#');
    const hrefFor = section => (section.href.startsWith('#') && !viewsOnThisPage ? `dashboard.html${section.href}` : section.href);
    const links = dashboard.sections.map(section => `
      <li>
        <a href="${hrefFor(section)}" class="ph-dash-nav-link" data-dashboard-section="${section.id}"${section.id === active ? ' aria-current="page"' : ''}>
          <i class="${section.icon}" aria-hidden="true"></i>
          <span class="ph-dash-nav-label">${escape(section.label)}</span>
          <span class="ph-dash-nav-short" aria-hidden="true">${escape(section.short)}</span>
        </a>
      </li>
    `).join('');
    const brand = `
      <a href="../../index.html" class="ph-dash-brand" aria-label="PetHub website">
        <img src="../../assets/images/paw.png" alt="" width="36" height="36">
        <span><span class="ph-dash-brand-name">PetHub</span><span class="ph-dash-brand-role">${escape(dashboard.label)}</span></span>
      </a>
    `;

    const template = document.createElement('template');
    template.innerHTML = `
      <header class="ph-dash-topbar">
        ${brand}
        <a href="#logout" class="btn-logout ph-btn ph-btn-secondary ph-btn-sm"><i class="ri-logout-circle-line" aria-hidden="true"></i>Log out</a>
      </header>
      <aside class="ph-dash-sidebar" aria-label="${escape(dashboard.label)}">
        <div class="ph-dash-sidebar-brand">${brand}</div>
        <nav class="ph-dash-nav" aria-label="${escape(dashboard.label)} sections">
          <p class="ph-dash-nav-heading" aria-hidden="true">Sections</p>
          <ul>${links}</ul>
        </nav>
        <div class="ph-dash-account">
          <p class="ph-dash-account-label">Signed in as</p>
          <p class="ph-dash-account-name" data-dashboard-account-name>${escape(getAccountName())}</p>
          <div class="ph-dash-account-links">
            <a href="../../index.html" class="ph-dash-account-link"><i class="ri-global-line" aria-hidden="true"></i>PetHub website</a>
            <a href="#logout" class="btn-logout ph-dash-account-link"><i class="ri-logout-circle-line" aria-hidden="true"></i>Log out</a>
          </div>
        </div>
      </aside>
    `;
    root.replaceWith(template.content);
  }

  // The sidebar's short labels repeat the full ones on phones; the full label stays the link's accessible name there too
  function labelShortLinks() {
    document.querySelectorAll('.ph-dash-nav-link').forEach(link => {
      const label = link.querySelector('.ph-dash-nav-label');
      if (label) link.setAttribute('aria-label', label.textContent.trim());
    });
  }

  function setActive(sectionId) {
    document.body.dataset.dashboardSection = sectionId;
    document.querySelectorAll('.ph-dash-nav-link').forEach(link => {
      if (link.dataset.dashboardSection === sectionId) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  function setAccountName(name) {
    const text = String(name || '').trim() || 'Your account';
    document.querySelectorAll('[data-dashboard-account-name]').forEach(element => {
      element.textContent = text;
    });
  }

  // Admin sections are views of one page: a click shows the view without reloading (js/admin/dashboard.js)
  function handleInPageSections() {
    document.addEventListener('click', event => {
      const link = event.target.closest('.ph-dash-nav-link[href^="#"]');
      if (!link || typeof window.showAdminView !== 'function') return;
      event.preventDefault();
      window.showAdminView(link.dataset.dashboardSection, { focusHeading: true });
    });
  }

  // The skip link moves focus to the page content without changing the address (Admin views use the address hash)
  function handleSkipLink() {
    document.querySelectorAll('.ph-skip-link').forEach(link => {
      link.addEventListener('click', event => {
        const target = document.getElementById('main');
        if (!target) return;
        event.preventDefault();
        target.focus();
        target.scrollIntoView({ block: 'start' });
      });
    });
  }

  const root = document.getElementById('dashboardNavRoot');
  if (root) {
    renderNavigation(root);
    labelShortLinks();
    handleInPageSections();
    handleSkipLink();
  }

  window.PetHubDashboardShell = Object.freeze({ setActive, setAccountName });
})();
