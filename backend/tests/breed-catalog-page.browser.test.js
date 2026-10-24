// Admin breed catalog in headless Chrome. The API is mocked by helpers/browser.js; no real accounts or services are used.
// Opt-in (needs Chrome or Edge): PETHUB_BROWSER_TESTS=1 node --test tests/breed-catalog-page.browser.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, pageUrl, startBrowser, stopBrowser, openTab } = require('./helpers/browser');

const ADMIN = { id: 'admin-1', role: 'admin', email: 'admin@example.test', fullname: 'Test Admin', is_verified: true };
const initialBreeds = [
  { id: 'breed-dog', species: 'Dog', name: 'Aspin', recognition_status: 'unverified', source_organization: 'PetHub local descriptor', source_reviewed_at: '2026-10-22', is_active: true, updated_at: '2026-10-22T00:00:00Z' },
  { id: 'breed-cat', species: 'Cat', name: 'Bengal', recognition_status: 'recognized', source_organization: 'Cat Fanciers\' Association', source_url: 'https://cfa.org/breeds/', source_reviewed_at: '2026-10-22', is_active: true, updated_at: '2026-10-22T00:00:00Z' }
];
const savedBreed = { id: 'breed-new', species: 'Dog', name: 'Shiba Inu', recognition_status: 'unverified', source_organization: 'Fédération Cynologique Internationale', source_url: 'https://www.fci.be/en/Nomenclature/Default.aspx', is_active: true, updated_at: '2026-10-22T00:01:00Z' };
const response = (body, status = 200) => ({ status, body: { success: true, ...body } });

describe('Admin breed catalog page in a browser (mocked API)', { skip }, () => {
  before(startBrowser);
  after(stopBrowser);

  it('asks the server for each page with the current filters, keeps them across pages, and saves a new unverified breed', async () => {
    const page = (breeds, info = {}) => response({ breeds, page: 1, page_size: 20, total: breeds.length, total_pages: 1, ...info });
    const routes = {
      // One answer per request, in order: first page, Cat filter, all species, Next page, search, POST, reload
      '/admin/breeds': [
        page(initialBreeds, { total: 45, total_pages: 3 }),
        page([initialBreeds[1]], { total: 1 }),
        page(initialBreeds, { total: 45, total_pages: 3 }),
        page([initialBreeds[0]], { page: 2, total: 45, total_pages: 3 }),
        page([initialBreeds[0]], { total: 1 }),
        response({ breed: savedBreed }, 201),
        page([initialBreeds[0], savedBreed], { total: 2 })
      ]
    };
    const tab = await openTab({
      url: pageUrl('pages/admin/breeds.html'),
      session: ADMIN,
      scenario: { routes }
    });
    const gets = () => tab.evaluate(`window.__requests.filter(request => request.route === '/admin/breeds' && request.method === 'GET').map(request => Object.fromEntries(new URLSearchParams(request.path.split('?')[1] || '')))`);
    try {
      assert.ok(await tab.waitFor(`document.querySelector('[data-breed-edit="breed-dog"]')`), 'the catalog loads');
      assert.match(await tab.evaluate(`document.getElementById('breedCatalogList').innerText`), /Aspin[\s\S]*Bengal/);
      assert.match(await tab.evaluate(`document.getElementById('breedPagination').innerText`), /Page 1 of 3/);
      assert.match(await tab.evaluate(`document.getElementById('breedCount').textContent`), /Showing 1–2 of 45/);
      assert.deepEqual((await gets())[0], { page: '1', page_size: '20', species: 'all', status: 'active', sort: 'name_asc' });

      await tab.evaluate(`(() => { const filter = document.getElementById('breedSpeciesFilter'); filter.value = 'Cat'; filter.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      assert.ok(await tab.waitFor(`!/Aspin/.test(document.getElementById('breedCatalogList').innerText)`), 'the server answer for Cat is shown');
      assert.equal((await gets())[1].species, 'Cat');
      assert.equal(await tab.evaluate(`document.getElementById('breedPagination').hidden`), false);

      await tab.evaluate(`(() => { const filter = document.getElementById('breedSpeciesFilter'); filter.value = 'all'; filter.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      assert.ok(await tab.waitFor(`/Page 1 of 3/.test(document.getElementById('breedPagination').innerText)`));
      await tab.evaluate(`document.querySelector('#breedPagination [data-page="2"]').click()`);
      assert.ok(await tab.waitFor(`/Page 2 of 3/.test(document.getElementById('breedPagination').innerText)`), 'page 2 is shown');
      assert.deepEqual((await gets())[3], { page: '2', page_size: '20', species: 'all', status: 'active', sort: 'name_asc' });
      assert.equal(await tab.evaluate(`document.querySelector('#breedPagination [aria-current="page"]').textContent`), '2');

      // Typing waits for a pause, then starts again at page 1 with the search text
      await tab.evaluate(`(() => { const box = document.getElementById('breedSearch'); box.value = 'asp'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      assert.ok(await tab.waitFor(`window.__requests.filter(request => request.route === '/admin/breeds').length === 5`, 3000));
      assert.deepEqual((await gets())[4], { page: '1', page_size: '20', species: 'all', status: 'active', sort: 'name_asc', q: 'asp' });

      await tab.evaluate(`(() => {
        document.getElementById('breedSpecies').value = 'Dog';
        document.getElementById('breedName').value = 'Shiba Inu';
        document.getElementById('breedSource').value = 'Fédération Cynologique Internationale';
        document.getElementById('breedSourceUrl').value = 'https://www.fci.be/en/Nomenclature/Default.aspx';
        document.getElementById('breedCreateForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()`);
      const savedEntryVisible = await tab.waitFor(`document.querySelector('[data-breed-edit="breed-new"]')`);
      assert.ok(savedEntryVisible, 'the page reloads the catalog after a successful save');
      assert.match(await tab.evaluate(`document.getElementById('breedCatalogList').innerText`), /Shiba Inu/);
      assert.match(await tab.evaluate(`document.getElementById('breedCatalogFeedback').textContent`), /Breed added as Unverified/);
      assert.equal((await gets())[5].q, 'asp', 'the reload keeps the search');
      const post = await tab.evaluate(`window.__requests.filter(request => request.route === '/admin/breeds' && request.method === 'POST').map(request => JSON.parse(request.body))`);
      assert.deepEqual(post, [{ species: 'Dog', name: 'Shiba Inu', source_organization: 'Fédération Cynologique Internationale', source_url: 'https://www.fci.be/en/Nomenclature/Default.aspx' }]);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('shows an empty result without page navigation', async () => {
    const tab = await openTab({
      url: pageUrl('pages/admin/breeds.html'),
      session: ADMIN,
      scenario: { routes: { '/admin/breeds': response({ breeds: [], page: 1, page_size: 20, total: 0, total_pages: 1 }) } }
    });
    try {
      assert.ok(await tab.waitFor(`/No catalog entries match/.test(document.getElementById('breedCatalogList').innerText)`));
      assert.equal(await tab.evaluate(`document.getElementById('breedPagination').hidden`), true);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  // The API only accepts http(s) source links, but a row written straight into the database is not checked by it
  it('links only http(s) sources: a stored javascript: address is not made clickable', async () => {
    const unsafe = { ...initialBreeds[0], id: 'breed-unsafe', name: 'Unsafe Source', source_url: 'javascript:window.__clicked=1//' };
    const tab = await openTab({
      url: pageUrl('pages/admin/breeds.html'),
      session: ADMIN,
      scenario: { routes: { '/admin/breeds': response({ breeds: [...initialBreeds, unsafe] }) } }
    });
    try {
      assert.ok(await tab.waitFor(`document.querySelector('[data-breed-edit="breed-unsafe"]')`), 'the catalog loads');
      const hrefs = await tab.evaluate(`[...document.querySelectorAll('#breedCatalogList a')].map(link => link.getAttribute('href'))`);
      assert.deepEqual(hrefs, ['https://cfa.org/breeds/'], 'only the https source is a link');
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  // The other admin sections are views of dashboard.html; a bare "#overview" link would leave the admin on this page
  it('the dashboard navigation leads back to the admin dashboard views', async () => {
    const tab = await openTab({
      url: pageUrl('pages/admin/breeds.html'),
      session: ADMIN,
      scenario: { routes: { '/admin/breeds': response({ breeds: initialBreeds }) } }
    });
    try {
      assert.ok(await tab.waitFor(`document.querySelectorAll('.ph-dash-nav-link').length === 5`), 'the navigation renders');
      const links = await tab.evaluate(`Object.fromEntries([...document.querySelectorAll('.ph-dash-nav-link')].map(link => [link.dataset.dashboardSection, link.getAttribute('href')]))`);
      assert.deepEqual(links, {
        overview: 'dashboard.html#overview',
        appointments: 'dashboard.html#appointments',
        records: 'dashboard.html#records',
        system: 'dashboard.html#system',
        breeds: 'breeds.html'
      });
      await tab.click('.ph-dash-nav-link[data-dashboard-section="appointments"]');
      assert.ok(await tab.waitFor(`location.pathname.endsWith('/pages/admin/dashboard.html') && location.hash === '#appointments'`), 'opens the Appointments view');
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });
});
