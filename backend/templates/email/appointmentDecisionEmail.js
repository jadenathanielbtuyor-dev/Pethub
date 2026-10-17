const {
  APPOINTMENT_APPROVED_EMAIL_SUBJECT,
  APPOINTMENT_DECLINED_EMAIL_SUBJECT,
  APPOINTMENT_CANCELLED_EMAIL_SUBJECT
} = require('../../constants/email');
const { DEPOSIT_AMOUNT_PHP } = require('../../constants/payments');
const { getAppointmentDetails, buildAppointmentEmail } = require('./appointmentEmailParts');

const DEPOSIT_LABEL = `₱${DEPOSIT_AMOUNT_PHP.toFixed(2)}`;

// decision: 'approved' | 'cancelled'. previousStatus tells a declined request (Pending) from a cancelled booking (Approved).
// depositStatus: 'paid' (a refund is now due) | 'refunded' | 'none'. A refund is never described as done unless PayMongo confirmed it.
function buildAppointmentDecisionEmail({ name, appointment, decision, previousStatus, depositStatus = 'none', appointmentsUrl = '' }) {
  if (decision === 'approved') {
    return buildAppointmentEmail({
      subject: APPOINTMENT_APPROVED_EMAIL_SUBJECT,
      heading: 'Appointment Approved',
      name,
      intro: 'The clinic approved your appointment. Your time slot is now reserved.',
      details: [
        ...getAppointmentDetails(appointment),
        ['Appointment status', 'Approved'],
        ['Deposit', `${DEPOSIT_LABEL} paid`]
      ],
      paragraphs: ['Please arrive a few minutes early. If you need to change this appointment, contact the clinic.'],
      appointmentsUrl
    });
  }

  const declined = previousStatus === 'Pending';
  const depositRows = {
    paid: [['Deposit', `${DEPOSIT_LABEL} paid — refund due`]],
    refunded: [['Deposit', 'Refunded']],
    none: [['Deposit', 'No payment recorded']]
  };
  const depositParagraphs = {
    paid: [
      `Because your ${DEPOSIT_LABEL} deposit was paid, it is due for a refund under the clinic's refund policy. The clinic processes the refund through PayMongo.`,
      'This email does not mean the refund has been completed. PetHub will show "Deposit refunded" once PayMongo confirms it. If you have questions about the refund, contact the clinic.'
    ],
    refunded: ['Your deposit for this appointment has already been refunded.'],
    none: ['No deposit payment was recorded for this appointment, so there is nothing to refund.']
  };
  const depositKey = Object.prototype.hasOwnProperty.call(depositRows, depositStatus) ? depositStatus : 'none';

  return buildAppointmentEmail({
    subject: declined ? APPOINTMENT_DECLINED_EMAIL_SUBJECT : APPOINTMENT_CANCELLED_EMAIL_SUBJECT,
    heading: declined ? 'Appointment Request Declined' : 'Appointment Cancelled',
    name,
    intro: declined
      ? 'The clinic was not able to approve your appointment request below.'
      : 'The clinic cancelled your appointment below.',
    details: [
      ...getAppointmentDetails(appointment),
      ['Appointment status', declined ? 'Not approved' : 'Cancelled'],
      ...depositRows[depositKey]
    ],
    paragraphs: [...depositParagraphs[depositKey], 'You can request another time from My Appointments in PetHub.'],
    appointmentsUrl
  });
}

module.exports = {
  buildAppointmentDecisionEmail
};
