const contactRepository = require('../repositories/contactRepository');
const activityLogsRepository = require('../repositories/activityLogsRepository');
const { hasValue } = require('../validators/commonValidator');
const { validateContactRequest } = require('../validators/contactValidator');

const submitContactRequest = async (req) => {
  try {
    const validation = validateContactRequest(req.body);
    if (validation.error) return validation.error;

    const { cleanName, cleanEmail, cleanMessage, normalizedUserId } = validation;

    const contactPayload = {
      fullname: cleanName,
      email: cleanEmail,
      message: cleanMessage,
      status: 'Unread'
    };

    const { error: contactError } = await contactRepository.createContactMessage(contactPayload);
    if (contactError) {
      console.error('Failed to store contact message:', contactError);
      return { statusCode: 500, body: { success: false, error: 'Failed to submit contact request' } };
    }

    // The name, email and message are kept once, in contact_messages; the activity log only records that one arrived
    const logPayload = {
      action: 'contact_message',
      details: 'Contact message received'
    };

    if (hasValue(normalizedUserId)) {
      logPayload.user_id = normalizedUserId;
    }

    const { error: logError } = await activityLogsRepository.insertActivityLog(logPayload);
    if (logError) {
      console.warn('Contact request saved, but failed to store activity log:', logError);
    }

    return { statusCode: 200, body: { success: true, message: 'Contact request received successfully.' } };
  } catch (error) {
    console.error('Contact request error:', error);
    return { statusCode: 500, body: { success: false, error: 'Server error processing contact request' } };
  }
};

module.exports = {
  submitContactRequest
};
