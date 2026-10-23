// The Pet Owner Dashboard and Admin Dashboard's four in-page views in the shared navigation, plus the separate
// admin Breed Catalog page
// (frontend/js/shared/dashboard-shell.js), the pages wired to it, the retired admin pages forwarding to the matching
// section, every API path the dashboards call being a route the backend mounts, owner scripts never calling admin
// routes, no hard-coded figures, the AI assistant sent only a question and a page name, and online booking still
// closed with the catalog as shipped.
// Static file checks; behaviour in a browser is covered by dashboards.browser.test.js (opt-in).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '..');
const FRONTEND = path.join(BACKEND, '..', 'frontend');
const read = file => fs.readFileSync(path.join(FRONTEND, file), 'utf8');
const scriptsOf = page => [...page.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);

const OWNER_PAGES = {
  overview: 'pages/user/dashboard.html',
  pets: 'pages/user/pets.html',
  appointments: 'pages/user/appointments.html',
  health: 'pages/user/health.html'
};
const OWNER_SCRIPTS = {
  overview: 'user/dashboard.js',
  pets: 'user/pets.js',
  appointments: 'user/appointments.js',
  health: 'user/health.js'
};

function getShellSections(dashboard) {
  const shell = read('js/shared/dashboard-shell.js');
  const block = shell.match(new RegExp(`\\b${dashboard}: \\{[\\s\\S]*?sections: \\[([\\s\\S]*?)\\]\\s*\\}`));
  assert.ok(block, `the shell defines the ${dashboard} dashboard`);
  return [...block[1].matchAll(/\{ id: '([^']+)', href: '([^']+)', icon: '[^']+', label: '([^']+)', short: '([^']+)' \}/g)]
    .map(([, id, href, label, short]) => ({ id, href, label, short }));
}

describe('Dashboard navigation: four sections each', () => {
  it('the Pet Owner Dashboard has Overview, My Pets, Appointments and Pet Health & AI Assistant, each a page that exists', () => {
    const sections = getShellSections('owner');
    assert.deepEqual(sections.map(section => section.label), ['Overview', 'My Pets', 'Appointments', 'Pet Health & AI Assistant']);
    assert.deepEqual(sections.map(section => section.id), Object.keys(OWNER_PAGES));
    sections.forEach(section => {
      assert.equal(`pages/user/${section.href}`, OWNER_PAGES[section.id]);
      assert.ok(fs.existsSync(path.join(FRONTEND, OWNER_PAGES[section.id])), section.href);
    });
    assert.match(read('js/shared/dashboard-shell.js'), /label: 'Pet Owner Dashboard'/);
  });

  it('the Admin Dashboard keeps its four views and links to a separate Breed Catalog page', () => {
    const sections = getShellSections('admin');
    const dashboardSections = sections.slice(0, 4);
    assert.deepEqual(dashboardSections.map(section => section.label), ['Overview', 'Appointment Management', 'Pet Owners & Records', 'System Management']);
    assert.deepEqual(dashboardSections.map(section => section.href), ['#overview', '#appointments', '#records', '#system']);
    assert.deepEqual(sections.slice(4).map(section => [section.label, section.href]), [['Breed Catalog', 'breeds.html']]);
    assert.ok(fs.existsSync(path.join(FRONTEND, 'pages/admin/breeds.html')));

    const page = read('pages/admin/dashboard.html');
    assert.match(page, /<body[^>]*data-dashboard="admin"[^>]*data-dashboard-section="overview"/);
    const views = [...page.matchAll(/<section id="(adminView\w+)"[^>]*>/g)].map(match => match[0]);
    assert.deepEqual(views.map(tag => tag.match(/id="(\w+)"/)[1]), ['adminViewOverview', 'adminViewAppointments', 'adminViewRecords', 'adminViewSystem']);
    assert.doesNotMatch(views[0], /\bhidden\b/, 'the Overview shows first');
    views.slice(1).forEach(tag => assert.match(tag, /\bhidden\b/));

    // Each section heading, and the chatbot's description of the Admin Dashboard, use the navigation's names
    for (const section of dashboardSections) {
      assert.ok(page.includes(`ph-dash-title" tabindex="-1">${section.label.replace(/&/g, '&amp;')}</h1>`), `${section.label} heading`);
    }
    const chatbot = fs.readFileSync(path.join(BACKEND, 'services', 'aiService.js'), 'utf8');
    assert.ok(chatbot.includes(`- Admin Dashboard: ${dashboardSections.map(section => section.label).join(', ')}`), 'the chatbot lists the four dashboard sections');
    assert.match(chatbot, /- Breed Catalog: a separate Admin Dashboard page/);
    assert.doesNotMatch(chatbot, /Pet & Medical Records/, 'no earlier section name');
  });

  it('every Pet Owner page is labelled Pet Owner Dashboard, marks its own section and loads the shell after the session helpers', () => {
    for (const [section, file] of Object.entries(OWNER_PAGES)) {
      const page = read(file);
      assert.match(page, new RegExp(`<body[^>]*data-dashboard="owner"[^>]*data-dashboard-section="${section}"`), file);
      assert.match(page, /<div id="dashboardNavRoot"><\/div>/, file);
      assert.match(page, /<p class="ph-dash-eyebrow">Pet Owner Dashboard<\/p>/, file);
      assert.doesNotMatch(page, /User Dashboard/, `${file} no longer says "User Dashboard"`);
      const scripts = scriptsOf(page);
      for (const ref of scripts) assert.ok(fs.existsSync(path.resolve(path.dirname(path.join(FRONTEND, file)), ref)), `${ref} exists`);
      const order = ['core/api.js', 'core/storage.js', 'main.js', 'shared/dashboard-shell.js', OWNER_SCRIPTS[section], 'shared/ai-widget.js']
        .map(name => scripts.findIndex(src => src.endsWith(name)));
      assert.ok(order.every(position => position >= 0), `${file} loads every script`);
      assert.deepEqual([...order].sort((a, b) => a - b), order, `${file} loads them in order`);
    }
  });

  it('the retired admin Users, Pets and Appointments pages forward to the matching section and load no admin script', () => {
    const forwards = {
      'pages/admin/appointments.html': 'dashboard.html#appointments',
      'pages/admin/pets.html': 'dashboard.html#records',
      'pages/admin/users.html': 'dashboard.html#users'
    };
    for (const [file, target] of Object.entries(forwards)) {
      const page = read(file);
      assert.ok(page.includes(`window.location.replace('${target}')`), file);
      assert.ok(page.includes(`href="${target}"`), `${file} links there too`);
      assert.deepEqual(scriptsOf(page), [], `${file} loads no scripts`);
    }
    // Earlier addresses are understood by the dashboard
    const script = read('js/admin/dashboard.js');
    for (const hash of ['users', 'pets', 'messages', 'activityLogs', 'management', 'medicalRecords', 'analytics']) {
      assert.match(script, new RegExp(`\\b${hash}: \\{ view: '`), hash);
    }
  });
});

describe('Dashboard data: real API routes and no invented figures', () => {
  const DASHBOARD_SCRIPTS = ['js/user/dashboard.js', 'js/user/pets.js', 'js/user/appointments.js', 'js/user/health.js', 'js/admin/dashboard.js', 'js/admin/breeds.js', 'js/shared/ai-widget.js'];

  // "/pets/userPets" from `${window.API_BASE_URL}/pets/userPets?user_id=...`, getOwnerJson(`/pets/...`) and
  // requestPetsApi('/pets/...') (My Pets)
  function getCalledPaths(source) {
    const paths = [
      ...[...source.matchAll(/\$\{(?:window\.API_BASE_URL|AI_WIDGET_API)\}(\/[A-Za-z0-9/_-]+)/g)].map(match => match[1]),
      ...[...source.matchAll(/(?:getOwnerJson|requestPetsApi)\([`'](\/[A-Za-z0-9/_-]+)/g)].map(match => match[1])
    ];
    return [...new Set(paths.map(value => value.replace(/\/$/, '')))];
  }

  function getMountedRoutes() {
    const server = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8');
    const files = Object.fromEntries([...server.matchAll(/const (\w+) = require\('\.\/routes\/(\w+)'\)/g)].map(([, variable, file]) => [variable, file]));
    return [...server.matchAll(/app\.use\('(\/\w+)', (\w+)\)/g)].flatMap(([, prefix, variable]) => {
      if (!files[variable]) return [];
      const routes = fs.readFileSync(path.join(BACKEND, 'routes', `${files[variable]}.js`), 'utf8');
      return [...routes.matchAll(/router\.(get|post|put|delete)\('([^']+)'/g)].map(([, method, route]) => ({
        method: method.toUpperCase(),
        pattern: new RegExp(`^${(prefix + (route === '/' ? '' : route)).replace(/:\w+/g, '[^/]+')}$`)
      }));
    });
  }

  it('every path the dashboards call is a route the backend mounts', () => {
    const mounted = getMountedRoutes();
    assert.ok(mounted.length > 20);
    for (const file of DASHBOARD_SCRIPTS) {
      const called = getCalledPaths(read(file));
      assert.ok(called.length > 0, file);
      for (const route of called) {
        // Routes ending in /:id (DELETE /pets/delete/:id, PUT /pets/update/:id, GET /pets/history/:id) are built as
        // `.../pets/delete/${id}`
        const candidate = ['/pets/delete', '/pets/update', '/pets/history', '/appointments/cancel'].includes(route) ? `${route}/some-id`
          : route === '/pets/' || route === '/pets' ? '/pets/some-id/weight-reports'
            : route === '/admin/breeds' ? '/admin/breeds'
              : route === '/admin/breeds/' ? '/admin/breeds/some-id' : route;
        assert.ok(mounted.some(entry => entry.pattern.test(candidate)), `${file} calls ${route}, which the backend does not mount`);
      }
    }
  });

  it('Pet Owner scripts never call admin routes, and only the Admin Dashboard writes medical records', () => {
    for (const file of ['js/user/dashboard.js', 'js/user/pets.js', 'js/user/appointments.js', 'js/user/health.js', 'js/shared/dashboard-shell.js']) {
      const called = getCalledPaths(read(file));
      assert.deepEqual(called.filter(route => route.startsWith('/admin')), [], file);
      assert.deepEqual(called.filter(route => /medical-records\/create/.test(route)), [], file);
    }
    assert.deepEqual(getCalledPaths(read('js/admin/dashboard.js')).filter(route => /medical-records/.test(route)), ['/admin/dashboard/medical-records/create']);
  });

  it('figures start as "Loading..." in the pages and are filled only from loaded records', () => {
    const overview = read(OWNER_PAGES.overview);
    for (const id of ['ownerStatPets', 'ownerStatUpcoming', 'ownerStatPending']) {
      assert.match(overview, new RegExp(`id="${id}"[^>]*>Loading\\.\\.\\.<`), id);
    }
    const admin = read('pages/admin/dashboard.html');
    for (const id of ['statPetOwners', 'statPets', 'statAppointments', 'statPending']) {
      assert.match(admin, new RegExp(`id="${id}"[^>]*>Loading\\.\\.\\.<`), id);
    }
    // A failed request shows "Unavailable" (never 0) for both dashboards
    assert.match(read('js/user/dashboard.js'), /element\.textContent = isCount \? String\(value\) : 'Unavailable'/);
    assert.match(read('js/admin/dashboard.js'), /return unavailable \? 'Unavailable' : formatDashboardValue\(value\)/);
  });

  it('the AI assistant sends the question, page and bounded in-memory history; the Pet Health page opens that assistant', () => {
    const widget = read('js/shared/ai-widget.js');
    assert.match(widget, /history:\s*inMemoryChatHistory\.slice\(-10\)/);
    assert.match(widget, /text:\s*String\(entry\.text \|\| ''\)\.slice\(0, 1200\)/);
    assert.match(widget, /window\.PetHubAI = Object\.freeze\(\{ open: openAssistant, ask: askAssistant \}\)/);
    const health = read('js/user/health.js');
    assert.deepEqual(getCalledPaths(health).sort(), ['/pets/medical-records', '/pets/userPets'], 'the page calls no chat endpoint of its own');
    assert.ok(/window\.PetHubAI\.ask\(/.test(health), 'suggested questions go to the existing assistant');
  });

  it('with the service catalog as shipped, no service can be booked online, so booking stays closed on both dashboards', () => {
    const services = require('../constants/services');
    const { listServicesForClient } = require('../utils/serviceCatalog');
    assert.equal(services.STANDARD_DURATION_MINUTES, null);
    assert.equal(services.SERVICE_CATALOG.length, 9);
    assert.ok(services.SERVICE_CATALOG.every(service => service.durationMinutes === null));
    assert.ok(listServicesForClient().every(service => service.bookable === false));
    assert.match(read('js/user/appointments.js'), /function updateBookingClosedNotice\(\)/);
    assert.match(read('js/admin/dashboard.js'), /Online booking is closed/);
  });

  it('the dashboard shell styles are in both the source and the compiled CSS', () => {
    for (const file of ['input.css', 'style.css']) {
      const css = read(`assets/css/${file}`);
      assert.match(css, /\.ph-dash-sidebar \{\s*position: sticky;/, `${file}: sticky navigation`);
      assert.match(css, /\.ph-dash-table-wrap \{\s*position: relative;/, `${file}: tables scroll inside their card`);
      assert.match(css, /body\.dark-mode \.ph-dash-panel/, `${file}: dark mode`);
    }
  });
});
