const supabase = require('../config/supabase');

const CONTACT_MESSAGE_SELECT = 'id, fullname, email, message, status, created_at';

function createContactMessage(message) {
  return supabase
    .from('contact_messages')
    .insert([message]);
}

function listMessages() {
  return supabase
    .from('contact_messages')
    .select(CONTACT_MESSAGE_SELECT)
    .order('created_at', { ascending: false });
}

function findStatusById(messageId) {
  return supabase
    .from('contact_messages')
    .select('id, status')
    .eq('id', messageId)
    .maybeSingle();
}

function updateStatus(messageId, status) {
  return supabase
    .from('contact_messages')
    .update({ status })
    .eq('id', messageId)
    .select(CONTACT_MESSAGE_SELECT)
    .maybeSingle();
}

module.exports = {
  createContactMessage,
  listMessages,
  findStatusById,
  updateStatus
};
