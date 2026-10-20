// The booking page as shipped (frontend/pages/user/appointments.html): a booking summary and an orange
// "Book Appointment" button, with no deposit, payment or PayMongo content. Also checks that the page's scripts exist
// and that the only endpoints the booking script calls are ones the backend mounts.
// Static file checks only; the behaviour in a browser is covered by booking-page.browser.test.js (opt-in).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const PAGE_PATH = path.join(FRONTEND, 'pages', 'user', 'appointments.html');
const read = file => fs.readFileSync(file, 'utf8');
const page = read(PAGE_PATH);
const textOf = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const PAYMENT_WORDING = /deposit|payment|paymongo|checkout|refund|₱|e-wallet|gcash/i;

function getForm() {
  const match = page.match(/<form id="appointmentForm"[\s\S]*?<\/form>/);
  assert.ok(match, 'the booking form is on the page');
  return match[0];
}

describe('Booking page: summary and button', () => {
  it('shows a booking summary between the booking fields and the submit button', () => {
    const form = getForm();
    const section = form.match(/<section id="bookingSummary"([^>]*)>([\s\S]*?)<\/section>/);
    assert.ok(section, 'the booking summary is inside the booking form');
    assert.doesNotMatch(section[1], /\bhidden\b/, 'the summary is not hidden by default');

    const timeInputAt = form.indexOf('id="appointmentTime"');
    const summaryAt = form.indexOf('id="bookingSummary"');
    const submitAt = form.indexOf('type="submit"');
    assert.ok(timeInputAt >= 0 && timeInputAt < summaryAt && summaryAt < submitAt, 'fields, then the summary, then the button');

    const text = textOf(section[2]);
    assert.match(text, /Booking Summary/);
    for (const label of ['Selected pet', 'Selected service', 'Date and time', 'Estimated duration']) {
      assert.ok(text.includes(label), `shows "${label}"`);
    }
    for (const id of ['bookingSummaryPet', 'bookingSummaryService', 'bookingSummaryDateTime', 'bookingSummaryDuration']) {
      assert.ok(section[2].includes(`id="${id}"`), `has #${id}`);
    }
  });

  it('has "Book Appointment" as the only submit action, disabled until the details are valid', () => {
    const form = getForm();
    const buttons = [...form.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
    assert.equal(buttons.length, 1, 'one button in the booking form');
    const [, attributes, label] = buttons[0];
    assert.match(attributes, /type="submit"/);
    assert.match(attributes, /\bdisabled\b/);
    assert.match(attributes, /\bbooking-submit-button\b/);
    assert.equal(textOf(label), 'Book Appointment');
  });

  it('has no deposit, payment or PayMongo content anywhere on the page', () => {
    assert.doesNotMatch(textOf(page), PAYMENT_WORDING);
    assert.doesNotMatch(page, /depositPanel|depositPaymentStatus|deposit-pay-button|deposit-panel-paw|bookingPaymentResult/);
  });

  it('styles the button and the summary paw with booking rules kept in both the compiled and the source CSS', () => {
    for (const file of ['style.css', 'input.css']) {
      const css = read(path.join(FRONTEND, 'assets', 'css', file));
      assert.match(css, /\.booking-submit-button \{\s*background-color: #c2410c;\s*color: #ffffff;/, `${file} defines the button colours`);
      assert.match(css, /\.booking-summary-paw \{\s*background-color: #ffedd5;/, `${file} defines the paw circle`);
      assert.doesNotMatch(css, /deposit|payment|paymongo/i, `${file} has no payment styles`);
    }
  });
});

describe('Booking page: scripts and API wiring', () => {
  it('loads scripts and styles that exist, with the API client first and the booking script after its helpers', () => {
    const scripts = [...page.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
    const styles = [...page.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(match => match[1]).filter(href => !/^https?:/.test(href));
    for (const ref of [...scripts, ...styles]) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(PAGE_PATH), ref)), `${ref} exists`);
    }
    const order = ['core/api.js', 'core/utils.js', 'core/storage.js', 'shared/appointment-durations.js', 'user/appointments.js'];
    const positions = order.map(name => scripts.findIndex(src => src.endsWith(name)));
    assert.ok(positions.every(position => position >= 0), 'every booking script is loaded');
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'in dependency order');
  });

  it('calls only the pet, appointment and booking endpoints that the backend mounts', () => {
    const script = read(path.join(FRONTEND, 'js', 'user', 'appointments.js'));
    const calls = [...script.matchAll(/`\$\{window\.API_BASE_URL\}(\/[^`?$]*)/g)].map(match => match[1]).sort();
    assert.deepEqual([...new Set(calls)], ['/appointments/all', '/appointments/create', '/appointments/services', '/appointments/userAppointments', '/pets/userPets']);
    assert.doesNotMatch(script, PAYMENT_WORDING);

    const server = read(path.join(__dirname, '..', 'server.js'));
    assert.match(server, /app\.use\('\/appointments', appointmentsRoutes\)/);
    assert.match(server, /app\.use\('\/pets', petsRoutes\)/);
    assert.doesNotMatch(server, /payments/i);
    const appointmentRoutes = read(path.join(__dirname, '..', 'routes', 'appointments.js'));
    assert.match(appointmentRoutes, /router\.get\('\/services', listServices\)/);
    assert.match(appointmentRoutes, /router\.post\('\/create', createAppointment\)/);
    assert.match(appointmentRoutes, /router\.get\('\/userAppointments', getUserAppointments\)/);
    assert.match(appointmentRoutes, /router\.get\('\/all', getAllAppointments\)/);
  });
});

describe('Other pages', () => {
  it('no frontend page or script mentions deposits, payments or PayMongo', () => {
    const files = [];
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (/\.(html|js)$/.test(entry.name) && !/config\.js$/.test(entry.name)) {
        files.push(full);
      }
    });
    walk(FRONTEND);
    assert.ok(files.length > 20);
    for (const file of files) {
      assert.doesNotMatch(read(file), /deposit|paymongo|checkout|refund|payment/i, path.relative(FRONTEND, file));
    }
  });
});
