// The owner's care reminders (GET /pets/care-recommendations), on the dashboard and on My Pets. A reminder appears after
// the clinic marks a visit Completed: when the next visit for that service may be due (from the clinic's schedule, or
// set by the clinic for this pet), or "ask the clinic" when the clinic has no schedule for that service. Reminders are
// general care guidance, not a diagnosis. The owner books only if they choose to ("Book this service" opens the booking
// form with the pet and service selected); "Got it" and "Dismiss" never book or cancel anything.

(function initCareReminders() {
  const CLINIC_TIME_ZONE = 'Asia/Manila';

  function clinicToday() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: CLINIC_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function formatDate(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return '';
    return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
  }

  function dueText(item) {
    if (!item.due_from) return `Ask the clinic when ${item.pet_name} should next have ${item.service_name}.`;
    const range = item.due_to && item.due_to !== item.due_from ? `${formatDate(item.due_from)} to ${formatDate(item.due_to)}` : `around ${formatDate(item.due_from)}`;
    return `Next ${item.service_name} for ${item.pet_name}: ${range}`;
  }

  function timing(item) {
    if (!item.due_from) return { label: 'Clinic advice needed', className: 'ph-badge' };
    const today = clinicToday();
    if ((item.due_to || item.due_from) < today) return { label: 'Past the suggested time', className: 'ph-badge ph-badge-warning' };
    if (item.due_from <= today) return { label: 'Due now', className: 'ph-badge ph-badge-warning' };
    const days = Math.round((Date.parse(`${item.due_from}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
    return days <= 14 ? { label: `Due in ${days} day${days === 1 ? '' : 's'}`, className: 'ph-badge ph-badge-official' } : { label: 'Upcoming', className: 'ph-badge' };
  }

  function bookingHref(item, fromPage) {
    const params = new URLSearchParams({ pet: item.pet_id, service: item.service_name });
    return `${fromPage === 'appointments' ? '' : '../user/'}appointments.html?${params.toString()}#bookTitle`;
  }

  function cardHtml(item, fromPage) {
    const when = timing(item);
    return `<article class="ph-care-card${item.basis === 'needs_review' ? ' is-review' : ''}" data-care-card="${escapeHtml(String(item.id))}">
      <p class="ph-care-due">${escapeHtml(dueText(item))}</p>
      <p class="mt-1"><span class="${when.className}">${escapeHtml(when.label)}</span>${item.basis === 'needs_review' ? '' : ` <span class="ph-badge">${escapeHtml(item.basis_label)}</span>`}${item.guidance_label ? ` <span class="ph-badge ph-badge-official">${escapeHtml(item.guidance_label)}</span>` : ''}${item.status === 'acknowledged' ? ' <span class="ph-badge">You marked this as seen</span>' : ''}</p>
      <p class="ph-dash-note mt-2"><strong>Why you see this:</strong> ${escapeHtml(item.explanation)}</p>
      <div class="ph-care-actions">
        ${item.bookable_now ? `<a class="ph-btn ph-btn-primary ph-btn-sm" href="${escapeHtml(bookingHref(item, fromPage))}"><i class="ri-calendar-event-line" aria-hidden="true"></i>Book this service</a>` : `<span class="ph-dash-note">${escapeHtml(item.service_name)} can't be booked online right now; <a class="ph-dash-link" href="../public/contact.html">contact the clinic</a>.</span>`}
        ${item.status === 'active' ? `<button type="button" class="ph-btn ph-btn-secondary ph-btn-sm" data-care-ack="${escapeHtml(String(item.id))}">Got it</button>` : ''}
        <button type="button" class="ph-btn ph-btn-ghost ph-btn-sm" data-care-dismiss="${escapeHtml(String(item.id))}">Dismiss</button>
      </div>
    </article>`;
  }

  async function load(container) {
    const fromPage = container.dataset.carePage || 'dashboard';
    container.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(`${window.API_BASE_URL}/pets/care-recommendations`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success !== true) throw new Error(data.error || `Could not load care reminders (${response.status}).`);
      const items = Array.isArray(data.recommendations) ? data.recommendations : [];
      if (data.available === false) {
        container.innerHTML = '<p class="ph-dash-note">Care reminders are not available yet.</p>';
      } else if (!items.length) {
        container.innerHTML = '<div class="ph-dash-empty"><p class="ph-dash-empty-title">No care reminders right now</p><p class="ph-dash-empty-text">After the clinic completes a visit, PetHub shows when the next one may be due.</p></div>';
      } else {
        container.innerHTML = `<div class="ph-care-list">${items.map(item => cardHtml(item, fromPage)).join('')}</div><p class="ph-dash-note mt-3">${escapeHtml(data.disclaimer || '')}</p>`;
      }
    } catch (error) {
      container.innerHTML = `<p class="ph-dash-note" role="alert">${escapeHtml(error.message || 'Care reminders are unavailable right now.')}</p>`;
    } finally {
      container.removeAttribute('aria-busy');
    }
  }

  async function change(container, button, action) {
    if (button.disabled) return;
    button.disabled = true;
    const status = document.getElementById(container.dataset.careStatus || '');
    try {
      const id = action === 'acknowledge' ? button.dataset.careAck : button.dataset.careDismiss;
      const response = await fetch(`${window.API_BASE_URL}/pets/care-recommendations/${encodeURIComponent(id)}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success !== true) throw new Error(data.error || 'Could not update this reminder.');
      if (status) status.textContent = action === 'dismiss' ? 'Reminder dismissed. Nothing was booked or cancelled.' : 'Marked as seen. Nothing was booked.';
      await load(container);
    } catch (error) {
      if (status) status.textContent = error.message;
      button.disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-care-reminders]').forEach(container => {
      container.addEventListener('click', event => {
        const ack = event.target.closest('[data-care-ack]');
        if (ack) return change(container, ack, 'acknowledge');
        const dismiss = event.target.closest('[data-care-dismiss]');
        if (dismiss) return change(container, dismiss, 'dismiss');
        return undefined;
      });
      if (typeof isLoggedIn === 'function' && isLoggedIn()) load(container);
    });
  });
})();
