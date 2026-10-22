// My Pets as shipped (static checks): the age field and the browser's age check use the server's 1-25 whole-year
// range (constants/pets.js), the page offers Register a new pet and Use an existing pet, nobody is told to add a pet
// again and delete the old one, the page calls only owner pet routes, the booking page preselects only the owner's own
// pet, the chatbot describes the feature as built, and the new styles are compiled.
// Behaviour in a browser is covered by pets-page.browser.test.js (opt-in).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PET_AGE_MIN_YEARS, PET_AGE_MAX_YEARS, PET_NAME_MAX_LENGTH, PET_BREED_MAX_LENGTH } = require('../constants/pets');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const read = file => fs.readFileSync(path.join(FRONTEND, file), 'utf8');
const page = read('pages/user/pets.html');
const script = read('js/user/pets.js');

function loadValidateAge() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(read('js/core/utils.js'), context);
  return context.validateAge;
}

describe('My Pets page: age rule and form', () => {
  it('the age fields use the server\'s range: whole years from 1 to 25, required', () => {
    assert.deepEqual([PET_AGE_MIN_YEARS, PET_AGE_MAX_YEARS], [1, 25]);
    const ageInput = page.match(/<input type="number" id="petAge"[^>]*>/)[0];
    for (const attribute of [`min="${PET_AGE_MIN_YEARS}"`, `max="${PET_AGE_MAX_YEARS}"`, 'step="1"', 'required']) {
      assert.ok(ageInput.includes(attribute), attribute);
    }
    assert.match(script, new RegExp(`id="petEditAge"[^>]*min="${PET_AGE_MIN_YEARS}" max="${PET_AGE_MAX_YEARS}" step="1"`));
    assert.match(page, /Whole years from 1 to 25\./);
    assert.doesNotMatch(page + script, /lifespan|life expectancy|average age/i, 'the range is not presented as a lifespan');
    assert.match(script, new RegExp(`PET_NAME_MAX_LENGTH = ${PET_NAME_MAX_LENGTH};`));
    assert.match(script, new RegExp(`PET_BREED_MAX_LENGTH = ${PET_BREED_MAX_LENGTH};`));
  });

  it('the browser\'s age check accepts 1 and 25 and refuses what the server refuses', () => {
    const validateAge = loadValidateAge();
    for (const age of ['1', '25', '7', ' 12 ', 1, 25]) assert.equal(validateAge(age).valid, true, `age ${JSON.stringify(age)}`);
    for (const age of ['0', '26', '-1', '2.5', '3.0', '1e1', '+3', 'abc', '', '   ', null, undefined, 0, 26]) {
      assert.equal(validateAge(age).valid, false, `age ${JSON.stringify(age)}`);
    }
    assert.equal(validateAge('26').error, 'Age must be a whole number of years from 1 to 25.');
    assert.equal(validateAge('').error, 'Enter the pet\'s age in whole years (1 to 25).');
  });

  it('every field has its own message, and the form is checked by the page script', () => {
    assert.match(page, /<form id="petForm" class="ph-form" novalidate>/);
    for (const id of ['petName', 'petType', 'petBreed', 'petAge']) {
      assert.match(page, new RegExp(`id="${id}Error" class="ph-field-error" hidden`), id);
      assert.match(page, new RegExp(`id="${id}"[^>]*aria-describedby="[^"]*${id}Error`), `${id} is described by its message`);
    }
  });
});

describe('My Pets page: register a new pet or use an existing one', () => {
  it('offers the two choices, each with its own panel', () => {
    assert.match(page, /data-pet-mode="new" aria-pressed="true" aria-controls="petNewPanel">Register a new pet</);
    assert.match(page, /data-pet-mode="existing" aria-pressed="false" aria-controls="petExistingPanel">Use an existing pet</);
    assert.match(page, /<div id="petExistingPanel" class="mt-4" hidden>/);
    assert.match(page, /no new profile is created/);
  });

  it('never tells owners to add a pet again and delete the old profile', () => {
    for (const source of [page, script, fs.readFileSync(path.join(__dirname, '..', 'services', 'aiService.js'), 'utf8')]) {
      assert.doesNotMatch(source, /add the pet again with the correct|then delete the old profile|doesn't have an edit option|there is no edit option/i);
    }
  });

  it('calls only the owner\'s pet routes, never a medical-record write or an admin route', () => {
    const calls = [...new Set([...script.matchAll(/requestPetsApi\([`'](\/[A-Za-z0-9/_-]+)/g)].map(match => match[1]))].sort();
    assert.deepEqual(calls, ['/pets/', '/pets/breeds', '/pets/create', '/pets/delete/', '/pets/history/', '/pets/update/', '/pets/userPets']);
    const code = script.replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /medical-records|\/admin\//);
    assert.equal(code.match(/\bfetch\(/g).length, 1, 'every request goes through requestPetsApi');
  });

  it('the booking page preselects ?pet= only when it is one of the owner\'s loaded pets', () => {
    const appointments = read('js/user/appointments.js');
    const body = appointments.match(/function applyRequestedPet\(\) \{([\s\S]*?)\n\}/)[1];
    assert.match(body, /!getAppointmentPetById\(requested\)\) return;/);
    assert.match(appointments, /renderAppointmentPetOptions\(\);\s*applyRequestedPet\(\);/);
  });
});

describe('My Pets: chatbot and styles', () => {
  it('the chatbot explains registering, editing and deleting as built', () => {
    const { FAQ_RESPONSES } = loadFaq();
    assert.match(FAQ_RESPONSES['how do i edit a pets profile'], /\*\*Edit profile\*\*/);
    assert.match(FAQ_RESPONSES['how do i add a pet'], /whole years, 1 to 25/);
    assert.match(FAQ_RESPONSES['how do i delete a pet'], /only be deleted while it has no appointments or official medical records/);
  });

  it('the My Pets styles are in both the source and the compiled CSS', () => {
    for (const file of ['input.css', 'style.css']) {
      const css = read(`assets/css/${file}`);
      for (const selector of ['.ph-pet-choice', '.ph-pet-id', '.ph-pet-notice', 'body.dark-mode .ph-pet-notice']) {
        assert.ok(css.includes(`${selector} {`), `${file}: ${selector}`);
      }
    }
  });
});

// The FAQ answers as the chatbot holds them
function loadFaq() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'aiService.js'), 'utf8');
  const entries = {};
  for (const key of ['how do i add a pet', 'how do i edit a pets profile', 'how do i delete a pet']) {
    const match = source.match(new RegExp(`'${key}': "([^"]+)"`));
    assert.ok(match, key);
    entries[key] = match[1];
  }
  return { FAQ_RESPONSES: entries };
}
