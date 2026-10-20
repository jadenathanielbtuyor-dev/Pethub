// The registration page as shipped (frontend/pages/auth/register.html + js/core/auth.js): required and optional
// fields, the existing API client and endpoints, and frontend rules that match the backend's.
// Static file checks only; the behaviour in a browser is covered by register-page.browser.test.js (opt-in).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const BACKEND = path.join(__dirname, '..');
const PAGE_PATH = path.join(FRONTEND, 'pages', 'auth', 'register.html');
const read = file => fs.readFileSync(file, 'utf8');
const page = read(PAGE_PATH);
const authScript = read(path.join(FRONTEND, 'js', 'core', 'auth.js'));
const profileRules = require(path.join(BACKEND, 'constants', 'userProfile.js'));

function getForm() {
  const match = page.match(/<form id="registerForm"[\s\S]*?<\/form>/);
  assert.ok(match, 'the registration form is on the page');
  return match[0];
}

describe('Registration page: fields', () => {
  it('asks for name, email, password and confirmation, with every other field optional', () => {
    const form = getForm();
    const inputs = [...form.matchAll(/<(input|select)\b[^>]*>/g)].map(match => match[0]);
    const nameOf = tag => tag.match(/name="([^"]+)"/)[1];
    assert.deepEqual(inputs.filter(tag => /\srequired\b/.test(tag)).map(nameOf), ['fullname', 'email', 'password', 'confirm_password']);
    assert.deepEqual(inputs.map(nameOf), [
      'fullname', 'email', 'password', 'confirm_password',
      'date_of_birth', 'gender', 'phone_number', 'address_line', 'barangay', 'city_municipality', 'province', 'postal_code'
    ]);
    assert.deepEqual(inputs.map(nameOf).slice(4).sort(), [...profileRules.PROFILE_COLUMNS].sort(), 'the optional fields are the profile columns');
    for (const tag of inputs) {
      const id = tag.match(/id="([^"]+)"/)[1];
      assert.match(form, new RegExp(`<label for="${id}"`), `${id} has a label`);
    }
    assert.match(form, /<details id="personalDetails"[^>]*>/, 'personal details are a collapsible section');
    assert.doesNotMatch(form.match(/<details id="personalDetails"[^>]*>/)[0], /\sopen\b/, 'and start collapsed');
  });

  it('offers exactly the gender options the backend accepts, including "Prefer not to say"', () => {
    const select = getForm().match(/<select id="gender"[\s\S]*?<\/select>/)[0];
    const values = [...select.matchAll(/<option value="([^"]*)"/g)].map(match => match[1]).filter(Boolean);
    assert.deepEqual(values, [...profileRules.GENDER_OPTIONS]);
  });

  it('collects no government ID, payment, health or other unrelated data', () => {
    assert.doesNotMatch(getForm(), /government|national id|tin\b|sss|philhealth|passport|license|card number|payment|deposit|medical|diagnos/i);
  });

  it('links to the login page and to no policy page that does not exist', () => {
    assert.match(page, /<a href="login\.html">Log in<\/a>/);
    const pages = fs.readdirSync(path.join(FRONTEND, 'pages', 'public'));
    assert.ok(!pages.some(file => /privacy|terms/i.test(file)), 'no Privacy Policy or Terms page exists yet');
    assert.doesNotMatch(page, /href="[^"]*(privacy|terms)[^"]*"/i);
  });
});

describe('Registration page: scripts, styles and rules', () => {
  it('loads scripts and styles that exist, in dependency order, and styles the page from the compiled CSS', () => {
    const scripts = [...page.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
    const styles = [...page.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(match => match[1]).filter(href => !/^https?:/.test(href));
    for (const ref of [...scripts, ...styles]) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(PAGE_PATH), ref)), `${ref} exists`);
    }
    const order = ['core/api.js', 'core/utils.js', 'core/storage.js', 'main.js', 'core/auth.js'];
    assert.deepEqual(scripts.map(src => src.replace('../../js/', '')), order);

    const css = read(path.join(FRONTEND, 'assets', 'css', 'style.css'));
    const classes = new Set([...page.matchAll(/class="([^"]+)"/g)].flatMap(match => match[1].split(/\s+/)).filter(name => name.startsWith('register-')));
    for (const name of classes) {
      assert.ok(new RegExp(`\\.${name}[\\s{:.,\\[]`).test(css), `${name} is in the compiled style.css`);
    }
    assert.match(css, /\.register-submit \{[^}]*background-color: #c2410c;[^}]*color: #ffffff;/);
  });

  it('posts to the existing /auth/register endpoint through the shared API base URL, with no second backend URL', () => {
    assert.match(authScript, /fetch\(`\$\{getApiBaseUrl\(\)\}\/auth\/register`/);
    assert.doesNotMatch(authScript, /https?:\/\/[^'"`\s]*(railway|vercel|localhost)/i);
    const routes = read(path.join(BACKEND, 'routes', 'auth.js'));
    assert.match(routes, /router\.post\('\/register', register\)/);
  });

  it('never stores or logs passwords in the browser', () => {
    assert.doesNotMatch(authScript, /(local|session)Storage\.setItem\([^)]*password/i);
    assert.doesNotMatch(authScript, /console\.\w+\([^)]*\b(password|values|payload)\b/i);
  });

  it('uses the same limits as the backend validator', () => {
    const constant = name => Number(authScript.match(new RegExp(`const ${name} = (\\d+);`))[1]);
    assert.equal(constant('REGISTER_PASSWORD_MIN_LENGTH'), profileRules.PASSWORD_MIN_LENGTH);
    assert.equal(constant('REGISTER_PASSWORD_MAX_LENGTH'), profileRules.PASSWORD_MAX_LENGTH);
    assert.match(authScript, new RegExp(`REGISTER_EARLIEST_DATE_OF_BIRTH = '${profileRules.EARLIEST_DATE_OF_BIRTH}'`));
    const genderList = authScript.match(/REGISTER_GENDER_OPTIONS = \[([^\]]+)\]/)[1].split(',').map(item => item.trim().replace(/^'|'$/g, ''));
    assert.deepEqual(genderList, [...profileRules.GENDER_OPTIONS]);
    for (const [field, max] of Object.entries(profileRules.ADDRESS_MAX_LENGTHS)) {
      assert.match(authScript, new RegExp(`${field}: \\{ label: '[^']+', max: ${max} \\}`), `${field} limit`);
      assert.match(page, new RegExp(`name="${field}"[^>]*maxlength="${max}"`), `${field} input maxlength`);
    }
    assert.match(page, new RegExp(`name="fullname"[^>]*maxlength="${profileRules.FULLNAME_MAX_LENGTH}"`));
    assert.match(page, new RegExp(`name="email"[^>]*maxlength="${profileRules.EMAIL_MAX_LENGTH}"`));
    assert.match(page, new RegExp(`name="password"[^>]*maxlength="${profileRules.PASSWORD_MAX_LENGTH}"`));
  });
});
