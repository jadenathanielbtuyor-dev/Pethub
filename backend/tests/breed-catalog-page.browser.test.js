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

  it('filters by species, saves a new unverified breed, then shows the fresh server catalog response', async () => {
    const routes = {
      // GET, POST, then the fresh GET after the save.
      '/admin/breeds': [
        response({ breeds: initialBreeds }),
        response({ breed: savedBreed }, 201),
        response({ breeds: [...initialBreeds, savedBreed] })
      ]
    };
    const tab = await openTab({
      url: pageUrl('pages/admin/breeds.html'),
      session: ADMIN,
      scenario: { routes }
    });
    try {
      assert.ok(await tab.waitFor(`document.querySelector('[data-breed-edit="breed-dog"]')`), 'the catalog loads');
      assert.match(await tab.evaluate(`document.getElementById('breedCatalogList').innerText`), /Aspin/);
      assert.match(await tab.evaluate(`document.getElementById('breedCatalogList').innerText`), /Bengal/);

      await tab.evaluate(`(() => { const filter = document.getElementById('breedSpeciesFilter'); filter.value = 'Cat'; filter.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      assert.match(await tab.evaluate(`document.getElementById('breedCatalogList').innerText`), /Bengal/);
      assert.doesNotMatch(await tab.evaluate(`document.getElementById('breedCatalogList').innerText`), /Aspin/);
      await tab.evaluate(`(() => { const filter = document.getElementById('breedSpeciesFilter'); filter.value = 'all'; filter.dispatchEvent(new Event('change', { bubbles: true })); })()`);

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
      assert.match(await tab.evaluate(`document.getElementById('breedCatalogList').innerText`), /unverified/);
      assert.match(await tab.evaluate(`document.getElementById('breedCatalogFeedback').textContent`), /Breed added as Unverified/);

      const calls = await tab.evaluate(`window.__requests.filter(request => request.route === '/admin/breeds').map(request => ({ method: request.method, body: request.body && JSON.parse(request.body) }))`);
      assert.deepEqual(calls, [
        { method: 'GET', body: null },
        { method: 'POST', body: { species: 'Dog', name: 'Shiba Inu', source_organization: 'Fédération Cynologique Internationale', source_url: 'https://www.fci.be/en/Nomenclature/Default.aspx' } },
        { method: 'GET', body: null }
      ]);
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
});
