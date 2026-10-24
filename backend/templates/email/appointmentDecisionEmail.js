const {
  APPOINTMENT_APPROVED_EMAIL_SUBJECT,
  APPOINTMENT_CANCELLED_EMAIL_SUBJECT,
  APPOINTMENT_OWNER_CANCELLED_EMAIL_SUBJECT
} = require('../../constants/email');
const {
  getAppointmentDetails,
  buildAppointmentEmail,
  formatClinicTimestamp,
  getClinicHelp
} = require('./appointmentEmailParts');

// decision: 'approved' | 'cancelled'. previousStatus tells a cancelled request (Pending) from a cancelled booking (Approved).
// clinic / contactPageUrl: the clinic's contact details for the "Need help?" block (appointmentEmailParts.getClinicHelp).
function buildAppointmentDecisionEmail({ name, appointment, decision, previousStatus, appointmentsUrl = '', clinic = {}, contactPageUrl = '' }) {
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
    paragraphs: ['If you have questions about this, contact the clinic. You can request another time from My Appointments in PetHub.'],
    appointmentsUrl,
    help
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
  buildOwnerCancellationEmail
};
