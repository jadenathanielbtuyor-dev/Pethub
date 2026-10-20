const {
  APPOINTMENT_APPROVED_EMAIL_SUBJECT,
  APPOINTMENT_CANCELLED_EMAIL_SUBJECT
} = require('../../constants/email');
const { getAppointmentDetails, buildAppointmentEmail } = require('./appointmentEmailParts');

// decision: 'approved' | 'cancelled'. previousStatus tells a cancelled request (Pending) from a cancelled booking (Approved).
function buildAppointmentDecisionEmail({ name, appointment, decision, previousStatus, appointmentsUrl = '' }) {
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
      paragraphs: ['Please arrive a few minutes early. If you need to change this appointment, contact the clinic.'],
      appointmentsUrl
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
    appointmentsUrl
  });
}

module.exports = {
  buildAppointmentDecisionEmail
};
