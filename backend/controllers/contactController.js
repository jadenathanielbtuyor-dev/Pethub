const supabase = require('../config/supabase');

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

const submitContactRequest = async (req, res) => {
  try {
    const { name, email, message, user_id } = req.body || {};
    const cleanName = hasValue(name) ? String(name).trim() : '';
    const cleanEmail = hasValue(email) ? String(email).trim().toLowerCase() : '';
    const cleanMessage = hasValue(message) ? String(message).trim() : '';

    if (!cleanName || !cleanEmail || !cleanMessage) {
      return res.status(400).json({ success: false, error: 'Name, email, and message are required' });
    }

    if (!isEmailLike(cleanEmail)) {
      return res.status(400).json({ success: false, error: 'Enter a valid email address' });
    }

    const contactPayload = {
      fullname: cleanName,
      email: cleanEmail,
      message: cleanMessage,
      status: 'Unread'
    };

    const { error: contactError } = await supabase.from('contact_messages').insert([contactPayload]);
    if (contactError) {
      console.error('Failed to store contact message:', contactError);
      return res.status(500).json({ success: false, error: 'Failed to submit contact request' });
    }

    const logPayload = {
      action: 'contact_message',
      details: `Name: ${cleanName}; Email: ${cleanEmail}; Message: ${cleanMessage}`
    };

    if (hasValue(user_id)) {
      logPayload.user_id = String(user_id).trim();
    }

    const { error: logError } = await supabase.from('activity_logs').insert([logPayload]);
    if (logError) {
      console.warn('Contact request saved, but failed to store activity log:', logError);
    }

    res.json({ success: true, message: 'Contact request received successfully.' });
  } catch (error) {
    console.error('Contact request error:', error);
    res.status(500).json({ success: false, error: 'Server error processing contact request' });
  }
};

module.exports = { submitContactRequest };
