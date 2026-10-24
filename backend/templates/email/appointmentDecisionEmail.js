const {
  APPOINTMENT_APPROVED_EMAIL_SUBJECT,
  APPOINTMENT_CANCELLED_EMAIL_SUBJECT,
  APPOINTMENT_RESCHEDULED_EMAIL_SUBJECT,
  APPOINTMENT_OWNER_CANCELLED_EMAIL_SUBJECT
} = require('../../constants/email');
const {
  getAppointmentDetails,
  buildAppointmentEmail,
  formatClinicTimestamp,
  formatAppointmentDate,
  formatAppointmentTime,
  getClinicHelp
} = require('./appointmentEmailParts');

// For an appointment that is one pet of a multi-pet booking: names every pet of that booking with its service and time,
// and says that each pet's appointment is handled separately. groupPets: the booking's appointments, in order.
function groupParagraphs(appointment, groupPets = []) {
  if (!appointment?.group_id || !Array.isArray(groupPets) || groupPets.length < 2) return [];
  const list = groupPets.map(pet => `${pet.pet_name || 'Pet'} (${pet.service_type || 'service'}, ${formatAppointmentTime(pet.appointment_time, pet.estimated_duration_minutes)}, ${pet.status || 'status not recorded'})`).join('; ');
  return [`This appointment is one part of a booking for ${groupPets.length} pets: ${list}. The clinic updates each pet's appointment separately, so this email is about ${appointment.pet_name || 'this pet'} only.`];
}

// decision: 'approved' | 'cancelled'. previousStatus tells a cancelled request (Pending) from a cancelled booking (Approved).
// clinic / contactPageUrl: the clinic's contact details for the "Need help?" block (appointmentEmailParts.getClinicHelp).
function buildAppointmentDecisionEmail({ name, appointment, decision, previousStatus, appointmentsUrl = '', clinic = {}, contactPageUrl = '', groupPets = [] }) {
  const help = getClinicHelp(clinic, contactPageUrl);
  if (decision === 'approved') {
    return buildAppointmentEmail({
      subject: APPOINTMENT_APPROVED_EMAIL_SUBJECT,
      heading: 'Appointment Approved',
      name,
      intro: 'The clinic approved your appointment. Your time slot is now reserved.',
      details: [
        ...getAppointmentDetails(appointment),
        ['Appointment status', 'Approved']
      ],
      paragraphs: [
        ...groupParagraphs(appointment, groupPets),
        'Please arrive a few minutes early. If you need to change this appointment, contact the clinic.',
        'You can cancel it yourself in My Appointments until 2 hours before it starts.'
      ],
      appointmentsUrl,
      help
    });
  }

  return buildAppointmentEmail({
    subject: APPOINTMENT_CANCELLED_EMAIL_SUBJECT,
    heading: 'Appointment Cancelled',
    name,
    intro: previousStatus === 'Pending'
      ? 'The clinic cancelled your appointment request below.'
      : 'The clinic cancelled your appointment below.',
    details: [
      ...getAppointmentDetails(appointment),
      ['Appointment status', 'Cancelled']
    ],
    paragraphs: [
      ...groupParagraphs(appointment, groupPets),
      'If you have questions about this, contact the clinic. You can request another time from My Appointments in PetHub.'
    ],
    appointmentsUrl,
    help
  });
}

// Sent when the clinic moves an appointment to a new time (PUT /admin/appointments/:id/schedule)
function buildAppointmentRescheduledEmail({ name, appointment, previousDate, previousTime, appointmentsUrl = '', clinic = {}, contactPageUrl = '', groupPets = [] }) {
  return buildAppointmentEmail({
    subject: APPOINTMENT_RESCHEDULED_EMAIL_SUBJECT,
    heading: 'Appointment Rescheduled',
    name,
    intro: 'The clinic moved your appointment to a new time. The new details are below.',
    details: [
      ...getAppointmentDetails(appointment),
      ...(previousDate ? [['Previously', `${formatAppointmentDate(previousDate)}, ${formatAppointmentTime(previousTime, appointment?.estimated_duration_minutes)}`]] : []),
      ['Appointment status', String(appointment?.status || 'Not recorded')]
    ],
    paragraphs: [
      ...groupParagraphs(appointment, groupPets),
      'If the new time does not suit you, contact the clinic. You can cancel it yourself in My Appointments until 2 hours before it starts.'
    ],
    appointmentsUrl,
    help: getClinicHelp(clinic, contactPageUrl)
  });
}

// Sent once, after the owner's own cancellation is stored (POST /appointments/cancel/:id)
function buildOwnerCancellationEmail({ name, appointment, appointmentsUrl = '', clinic = {}, contactPageUrl = '' }) {
  const [reference, pet, service, date, time] = getAppointmentDetails(appointment);
  return buildAppointmentEmail({
    subject: APPOINTMENT_OWNER_CANCELLED_EMAIL_SUBJECT,
    heading: 'Your Appointment Has Been Cancelled',
    name,
    intro: 'Your appointment has been successfully cancelled. Your PetHub appointment details are listed below for your reference.',
    details: [
      reference,
      ['Customer', String(name || '').trim() || 'Not recorded'],
      pet,
      service,
      ['Original date', date[1]],
      ['Original time', time[1]],
      ['Appointment status', 'Cancelled'],
      ['Cancelled on', formatClinicTimestamp(appointment?.cancelled_at)]
    ],
    paragraphs: [
      'This confirms your cancellation; you do not need to do anything else.',
      'If you did not cancel this appointment, contact the clinic right away. You can book a new appointment from My Appointments whenever online booking is open.'
    ],
    appointmentsUrl,
    help: getClinicHelp(clinic, contactPageUrl)
  });
}

module.exports = {
  buildAppointmentDecisionEmail,
  buildAppointmentRescheduledEmail,
  buildOwnerCancellationEmail
};
