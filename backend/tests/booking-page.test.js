// The booking page as shipped (frontend/pages/user/appointments.html): the ₱100 deposit section is part of the page
// itself, so it shows even before (or without) any API answer, and the form's only action is the payment one.
// Also checks that the page's scripts exist and that the endpoints it calls are the ones the backend mounts.
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

function getForm() {
  const match = page.match(/<form id="appointmentForm"[\s\S]*?<\/form>/);
  assert.ok(match, 'the booking form is on the page');
  return match[0];
}

describe('Booking page: ₱100 deposit section', () => {
  it('is in the page markup, visible by default, between the booking fields and the submit button', () => {
    const form = getForm();
    const section = form.match(/<section id="depositPanel"([^>]*)>([\s\S]*?)<\/section>/);
    assert.ok(section, 'the deposit section is inside the booking form');
    assert.doesNotMatch(section[1], /\bhidden\b/, 'the section is not hidden by default');

    const timeInputAt = form.indexOf('id="appointmentTime"');
    const sectionAt = form.indexOf('id="depositPanel"');
    const submitAt = form.indexOf('type="submit"');
    assert.ok(timeInputAt >= 0 && timeInputAt < sectionAt && sectionAt < submitAt, 'fields, then the deposit section, then the button');

    const text = textOf(section[2]);
    assert.match(text, /Appointment Deposit/);
    assert.match(text, /₱100\.00 PHP/);
    assert.match(text, /Pay the required deposit through secure PayMongo checkout to complete your booking submission\./);
    for (const label of ['Selected pet', 'Selected service', 'Date and time', 'Estimated duration', 'Deposit payment status']) {
      assert.ok(text.includes(label), `shows "${label}"`);
    }
  });

  it('has "Continue to Secure Payment — ₱100.00" as the only submit action, disabled until the page confirms payment is available', () => {
    const form = getForm();
    const buttons = [...form.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
    assert.equal(buttons.length, 1, 'one button in the booking form');
    const [, attributes, label] = buttons[0];
    assert.match(attributes, /type="submit"/);
    assert.match(attributes, /\bdisabled\b/);
    assert.equal(textOf(label), 'Continue to Secure Payment — ₱100.00');
    assert.doesNotMatch(textOf(form), /\bBook\b(?! Appointment)/, 'no plain "Book" action left in the form');
  });

  it('styles the button with the deposit-pay-button rule, kept in both the compiled and the source CSS', () => {
    for (const file of ['style.css', 'input.css']) {
      const css = read(path.join(FRONTEND, 'assets', 'css', file));
      assert.match(css, /\.deposit-pay-button \{\s*background-color: #c2410c;\s*color: #ffffff;/, `${file} defines the button colours`);
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

  it('calls the booking, checkout and payment-status endpoints that the backend mounts', () => {
    const script = read(path.join(FRONTEND, 'js', 'user', 'appointments.js'));
    assert.ok(script.includes('`${window.API_BASE_URL}/appointments/create`'));
    assert.ok(script.includes('`${window.API_BASE_URL}/payments/checkout`'));
    assert.ok(script.includes('`${window.API_BASE_URL}/payments/appointment/${encodeURIComponent(appointmentId)}`'));

    const server = read(path.join(__dirname, '..', 'server.js'));
    assert.match(server, /app\.use\('\/appointments', appointmentsRoutes\)/);
    assert.match(server, /app\.use\('\/payments', paymentsRoutes\)/);
    assert.match(read(path.join(__dirname, '..', 'routes', 'appointments.js')), /router\.post\('\/create', createAppointment\)/);
    const paymentsRoutes = read(path.join(__dirname, '..', 'routes', 'payments.js'));
    assert.match(paymentsRoutes, /router\.post\('\/checkout', createCheckout\)/);
    assert.match(paymentsRoutes, /router\.get\('\/appointment\/:appointmentId', getAppointmentPaymentStatus\)/);
  });
});
