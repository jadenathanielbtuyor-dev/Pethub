const supabase = require('../config/supabase');

const CONTACT_MESSAGE_SELECT = 'id, user_id, fullname, email, subject, message, status, created_at, reply_message, replied_at, handled_by';
// What the sender sees of their own messages (no admin ids)
const OWNER_MESSAGE_SELECT = 'id, subject, message, status, created_at, reply_message, replied_at';

function createContactMessage(message) {
  return supabase
    .from('contact_messages')
    .insert([message])
    .select(CONTACT_MESSAGE_SELECT)
    .maybeSingle();
}

// The same subject and text from the same account since `sinceIso` (a double-click, a retried request)
function findRecentDuplicate(userId, subject, message, sinceIso) {
  return supabase
    .from('contact_messages')
    .select(OWNER_MESSAGE_SELECT)
    .eq('user_id', userId)
    .eq('subject', subject)
    .eq('message', message)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

function listMessages() {
  return supabase
    .from('contact_messages')
    .select(CONTACT_MESSAGE_SELECT)
    .order('created_at', { ascending: false });
}

function listByUserId(userId, limit = 20) {
  return supabase
    .from('contact_messages')
    .select(OWNER_MESSAGE_SELECT)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
}

function findById(messageId) {
  return supabase
    .from('contact_messages')
    .select(CONTACT_MESSAGE_SELECT)
    .eq('id', messageId)
    .maybeSingle();
}

function findStatusById(messageId) {
  return supabase
    .from('contact_messages')
    .select('id, status')
    .eq('id', messageId)
    .maybeSingle();
}

// Unread -> Read only: a message that was already read or answered keeps its status
function markRead(messageId, adminId) {
  return supabase
    .from('contact_messages')
    .update({ status: 'Read', handled_by: adminId })
    .eq('id', messageId)
    .eq('status', 'Unread')
    .select(CONTACT_MESSAGE_SELECT)
    .maybeSingle();
}

// Saves the clinic's one reply; a message that was answered meanwhile is not overwritten (null data)
function saveReply(messageId, reply, adminId) {
  return supabase
    .from('contact_messages')
    .update({ reply_message: reply, replied_at: new Date().toISOString(), handled_by: adminId, status: 'Replied' })
    .eq('id', messageId)
    .in('status', ['Unread', 'Read'])
    .select(CONTACT_MESSAGE_SELECT)
    .maybeSingle();
}

module.exports = {
  createContactMessage,
  findRecentDuplicate,
  listMessages,
  listByUserId,
  findById,
  findStatusById,
  markRead,
  saveReply
};
