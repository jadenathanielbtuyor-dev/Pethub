const { DEPOSIT_RECEIPT_EMAIL_SUBJECT } = require('../../constants/email');
const { DEPOSIT_AMOUNT_PHP, DEPOSIT_CURRENCY } = require('../../constants/payments');
const { formatPaidAt, getAppointmentDetails, buildAppointmentEmail } = require('./appointmentEmailParts');

// Sent once, after PetHub has verified the payment with PayMongo. It must never read as an approval:
// the appointment still waits for the clinic, and only the clinic's approval reserves the time slot.
function buildDepositReceiptEmail({ name, appointment, payment, refundDue = false, appointmentsUrl = '' }) {
  const amount = `₱${DEPOSIT_AMOUNT_PHP.toFixed(2)} ${DEPOSIT_CURRENCY}`;
  const paidAt = formatPaidAt(payment?.paid_at);
  const details = [
    ...getAppointmentDetails(appointment),
    ['Deposit paid', amount],
    ['Payment status', 'Paid'],
    ...(payment?.provider_payment_id ? [['PayMongo payment reference', String(payment.provider_payment_id)]] : []),
    ...(paidAt ? [['Paid on', paidAt]] : [])
  ];

  const paragraphs = refundDue
    ? [
      'This appointment can no longer go ahead (it was cancelled, or its deposit had already been paid), so this payment is due for a refund under the clinic\'s refund policy.',
      'The clinic processes refunds through PayMongo. This email does not mean a refund has been made: PetHub will show "Deposit refunded" once PayMongo confirms it.'
    ]
    : [
      'Your appointment is not confirmed yet. It is now waiting for the clinic to review and approve it.',
      'Paying the deposit does not approve the appointment or reserve the time slot. We will email you when the clinic makes a decision.'
    ];

  return buildAppointmentEmail({
    subject: DEPOSIT_RECEIPT_EMAIL_SUBJECT,
    heading: 'Appointment Deposit Payment Confirmed',
    name,
    intro: `We received your ${amount} deposit for the PetHub appointment below.`,
    details,
    paragraphs,
    appointmentsUrl
  });
}

module.exports = {
  buildDepositReceiptEmail
};
