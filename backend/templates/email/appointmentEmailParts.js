// Shared pieces of the appointment emails (appointment approved and appointment cancelled).
// Appointment dates and times are clinic (Asia/Manila) wall-clock values, so they are formatted without time zone conversion.

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatAppointmentDate(dateValue) {
  const match = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return 'Not recorded';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function formatClockTime(totalMinutes) {
  const minutesInDay = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(minutesInDay / 60);
  const minutes = minutesInDay % 60;
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

function formatAppointmentTime(timeValue, durationMinutes) {
  const match = String(timeValue || '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return 'Not recorded';
  const start = Number(match[1]) * 60 + Number(match[2]);
  const duration = Number(durationMinutes);
  return Number.isFinite(duration) && duration > 0
    ? `${formatClockTime(start)} – ${formatClockTime(start + duration)}`
    : formatClockTime(start);
}

// The details every appointment email shows, as [label, value] pairs
function getAppointmentDetails(appointment) {
  return [
    ['Appointment ID', String(appointment?.id || 'Not recorded')],
    ['Pet', String(appointment?.pet_name || 'Not recorded')],
    ['Service', String(appointment?.service_type || 'Not recorded')],
    ['Date', formatAppointmentDate(appointment?.appointment_date)],
    ['Time', formatAppointmentTime(appointment?.appointment_time, appointment?.estimated_duration_minutes)]
  ];
}

function detailsText(details) {
  return details.map(([label, value]) => `${label}: ${value}`);
}

function detailsHtml(details) {
  const rows = details.map(([label, value]) => `
          <tr>
            <td style="padding: 6px 12px 6px 0; color: #6b7280; vertical-align: top; white-space: nowrap;">${escapeHtml(label)}</td>
            <td style="padding: 6px 0; font-weight: 600; color: #111827;">${escapeHtml(value)}</td>
          </tr>`).join('');
  return `<table role="presentation" style="border-collapse: collapse; margin: 16px 0; font-size: 14px;">${rows}
        </table>`;
}

function statusCheckText(appointmentsUrl) {
  return appointmentsUrl
    ? `To check your appointment status, sign in to PetHub and open My Appointments: ${appointmentsUrl}`
    : 'To check your appointment status, sign in to PetHub and open My Appointments.';
}

function statusCheckHtml(appointmentsUrl) {
  return appointmentsUrl
    ? `To check your appointment status, sign in to PetHub and open <a href="${escapeHtml(appointmentsUrl)}" style="color: #f97316;">My Appointments</a>.`
    : 'To check your appointment status, sign in to PetHub and open My Appointments.';
}

// Builds { subject, text, html } in the same style as the verification and password reset emails
function buildAppointmentEmail({ subject, heading, name, intro, details, paragraphs, appointmentsUrl }) {
  const displayName = String(name || 'PetHub user').trim() || 'PetHub user';
  return {
    subject,
    text: [
      `Hello ${displayName},`,
      '',
      intro,
      '',
      ...detailsText(details),
      '',
      ...paragraphs.flatMap(paragraph => [paragraph, '']),
      statusCheckText(appointmentsUrl),
      '',
      'Thank you,',
      'The PetHub Team'
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <h2 style="color: #f97316;">${escapeHtml(heading)}</h2>
        <p>Hello ${escapeHtml(displayName)},</p>
        <p>${escapeHtml(intro)}</p>
        ${detailsHtml(details)}
        ${paragraphs.map(paragraph => `<p>${escapeHtml(paragraph)}</p>`).join('\n        ')}
        <p>${statusCheckHtml(appointmentsUrl)}</p>
        <p>Thank you,<br/>The PetHub Team</p>
      </div>
    `
  };
}

module.exports = {
  getAppointmentDetails,
  buildAppointmentEmail
};
