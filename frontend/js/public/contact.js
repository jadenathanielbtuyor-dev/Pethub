// ==================== CONTACT PAGE ====================
// pages/public/contact.html
// - Clinic details: GET /contact/clinic-info lists only what the clinic has published (phone, email, address, hours).
// - Messages require a PetHub account. Signed out: a login prompt (login.html?next=contact returns here afterwards).
//   Signed in as a customer: subject + message, sent as POST /contact with the session token; the server takes the
//   sender's name and email from the account, so the form does not ask for them. Clinic staff are pointed to the
//   Admin Dashboard instead.
// - Your messages: GET /contact/mine, the customer's own messages with their status and the clinic's reply.

const CONTACT_MESSAGE_MAX_LENGTH = 2000;
let contactSubmitInProgress = false;

document.addEventListener('DOMContentLoaded', () => {
  loadClinicDetails();
  setupContactPanels();
});

function getContactUser() {
  const user = typeof getUser === 'function' ? getUser() : null;
  return user && typeof isLoggedIn === 'function' && isLoggedIn() ? user : null;
}

// ---------- Clinic details ----------

async function loadClinicDetails() {
  const container = document.getElementById('clinicDetails');
  if (!container) return;
  try {
    const response = await fetch(`${window.API_BASE_URL}/contact/clinic-info`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success !== true) throw new Error(data.error || 'unavailable');
    renderClinicDetails(container, data.clinic || {}, data.configured === true);
  } catch (error) {
    container.innerHTML = '<p class="ph-card-text">The clinic\'s contact details could not be loaded right now. Please try again later.</p>';
  }
}

function renderClinicDetails(container, clinic, configured) {
  if (!configured) {
    container.innerHTML = `
      <p class="ph-card-text">The clinic hasn't published its phone number, email or address on PetHub yet.</p>
      <p class="ph-card-text mt-2">Signed-in customers can send the clinic a message with the form on this page.</p>`;
    return;
  }

  const items = [];
  if (clinic.phone) {
    const href = clinic.phone_link ? `tel:${clinic.phone_link}` : '';
    items.push(clinicDetailItem('ri-phone-line', 'Phone', href
      ? `<a class="ph-link-arrow" href="${escapeHtml(href)}">${escapeHtml(clinic.phone)}</a>`
      : escapeHtml(clinic.phone)));
  }
  if (clinic.email) {
    items.push(clinicDetailItem('ri-mail-line', 'Email', `<a class="ph-link-arrow" href="mailto:${escapeHtml(clinic.email)}">${escapeHtml(clinic.email)}</a>`));
  }
  if (clinic.address) items.push(clinicDetailItem('ri-map-pin-line', 'Address', escapeHtml(clinic.address)));
  if (clinic.hours) items.push(clinicDetailItem('ri-time-line', 'Opening hours', escapeHtml(clinic.hours).replace(/\n/g, '<br>')));
  container.innerHTML = `<ul class="ph-info-list">${items.join('')}</ul>`;
}

function clinicDetailItem(icon, label, valueHtml) {
  return `
    <li>
      <span class="ph-icon" aria-hidden="true"><i class="${icon}"></i></span>
      <div><p class="ph-info-label">${label}</p><p class="ph-card-text">${valueHtml}</p></div>
    </li>`;
}

// ---------- Which panel the visitor sees ----------

function setupContactPanels() {
  const user = getContactUser();
  const signedOut = document.getElementById('contactSignedOut');
  const staffNote = document.getElementById('contactStaffNote');
  const form = document.getElementById('contactForm');
  if (!signedOut || !form) return;

  if (!user) {
    signedOut.hidden = false;
    return;
  }

  signedOut.hidden = true;
  if (String(user.role || '').toLowerCase() === 'admin') {
    if (staffNote) staffNote.hidden = false;
    return;
  }

  const sender = document.getElementById('contactSender');
  if (sender) {
    sender.textContent = '';
    sender.append('Sending as ');
    const name = document.createElement('strong');
    name.textContent = user.fullname || 'your account';
    sender.append(name);
    if (user.email) sender.append(` (${user.email}). The clinic replies to this address and on this page.`);
  }
  form.hidden = false;
  form.addEventListener('submit', handleContactSubmit);
  const message = document.getElementById('message');
  message?.addEventListener('input', () => {
    updateMessageCount();
    if (message.getAttribute('aria-invalid') === 'true') setContactFieldError('message', '');
  });
  document.getElementById('subject')?.addEventListener('input', event => {
    if (event.target.getAttribute('aria-invalid') === 'true') setContactFieldError('subject', '');
  });
  updateMessageCount();
  loadMyMessages();
}

function updateMessageCount() {
  const count = document.getElementById('messageCount');
  const length = (document.getElementById('message')?.value || '').length;
  if (count) count.textContent = `${length.toLocaleString('en-US')} / ${CONTACT_MESSAGE_MAX_LENGTH.toLocaleString('en-US')}`;
}

function setContactFieldError(id, message) {
  const input = document.getElementById(id);
  const error = document.getElementById(`${id}Error`);
  if (input) {
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    input.classList.toggle('is-invalid', Boolean(message));
  }
  if (error) {
    error.textContent = message || '';
    error.hidden = !message;
  }
}

// ---------- Sending ----------

async function handleContactSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (contactSubmitInProgress || isFormSubmitting(form)) return;

  const messageEl = document.getElementById('formMessage');
  clearMessage(messageEl);
  const subject = document.getElementById('subject').value.replace(/\s+/g, ' ').trim();
  const message = document.getElementById('message').value.trim();
  setContactFieldError('subject', subject ? '' : 'Enter a subject for your message.');
  setContactFieldError('message', message ? '' : 'Enter your message.');
  if (!subject || !message) {
    displayMessage(messageEl, !subject && !message ? 'Please fix the 2 highlighted fields.' : 'Please fix the highlighted field.', 'error');
    document.getElementById(subject ? 'message' : 'subject').focus();
    return;
  }

  contactSubmitInProgress = true;
  setFormSubmitting(form, true, 'Sending...', 'Send Message');
  try {
    const response = await fetch(`${window.API_BASE_URL}/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, message })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success !== true) {
      if (data.field === 'subject' || data.field === 'message') setContactFieldError(data.field, data.error);
      throw new Error(data.error || 'Your message could not be sent. Please try again.');
    }

    form.reset();
    updateMessageCount();
    displayMessage(messageEl, data.duplicate
      ? 'This message was already sent to the clinic. It is listed under Your messages below.'
      : 'Your message was sent to the clinic. You\'ll see the reply below, and it will be emailed to you.', 'success');
    loadMyMessages();
  } catch (error) {
    displayMessage(messageEl, error.message || 'Your message could not be sent. Please try again.', 'error');
  } finally {
    contactSubmitInProgress = false;
    setFormSubmitting(form, false, 'Sending...', 'Send Message');
  }
}

// ---------- Your messages ----------

const CONTACT_STATUS_CLASSES = {
  Unread: 'ph-status ph-status-pending',
  Read: 'ph-status ph-status-approved',
  Replied: 'ph-status ph-status-completed'
};

function formatMessageTime(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function messageTextHtml(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

async function loadMyMessages() {
  const section = document.getElementById('myMessages');
  const list = document.getElementById('myMessagesList');
  if (!section || !list) return;
  section.hidden = false;
  list.innerHTML = '<p class="ph-card-text" role="status">Loading your messages...</p>';
  try {
    const response = await fetch(`${window.API_BASE_URL}/contact/mine`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success !== true) throw new Error(data.error || 'Could not load your messages.');
    const messages = Array.isArray(data.messages) ? data.messages : [];
    if (!messages.length) {
      list.innerHTML = '<p class="ph-card-text">You haven\'t sent the clinic a message yet.</p>';
      return;
    }
    list.innerHTML = messages.map(message => `
      <article class="ph-message-item">
        <div class="ph-message-head">
          <p class="ph-message-subject">${escapeHtml(message.subject || 'Message')}</p>
          <span class="${CONTACT_STATUS_CLASSES[message.status] || 'ph-status ph-status-other'} px-2.5 py-1 text-xs">${escapeHtml(message.status_label || message.status)}</span>
        </div>
        <p class="ph-message-meta">Sent ${escapeHtml(formatMessageTime(message.created_at))}</p>
        <p class="ph-message-text">${messageTextHtml(message.message)}</p>
        ${message.reply_message ? `
        <div class="ph-message-reply">
          <p class="ph-message-meta"><strong>Reply from the clinic</strong> · ${escapeHtml(formatMessageTime(message.replied_at))}</p>
          <p class="ph-message-text">${messageTextHtml(message.reply_message)}</p>
        </div>` : ''}
      </article>`).join('');
  } catch (error) {
    list.innerHTML = `<p class="ph-card-text" role="alert">${escapeHtml(error.message || 'Could not load your messages.')}</p>`;
  }
}
