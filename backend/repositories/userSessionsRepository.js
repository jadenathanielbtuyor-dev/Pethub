const supabase = require('../config/supabase');

// Server-side sign-in sessions (database/migrations/2026-10-24_user_sessions.sql): one row per login. The signed token
// names its row; a session counts only while it is not revoked and not expired. Rows hold no token, IP or device.

function createSession(userId, expiresAt) {
  return supabase
    .from('user_sessions')
    .insert([{ user_id: userId, expires_at: new Date(expiresAt).toISOString() }])
    .select('id, expires_at')
    .maybeSingle();
}

function findActiveSession(sessionId, userId, nowIso = new Date().toISOString()) {
  return supabase
    .from('user_sessions')
    .select('id')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .is('revoked_at', null)
    .gt('expires_at', nowIso)
    .maybeSingle();
}

function revokeSession(sessionId, userId, reason) {
  return supabase
    .from('user_sessions')
    .update({ revoked_at: new Date().toISOString(), revoked_reason: reason })
    .eq('id', sessionId)
    .eq('user_id', userId)
    .is('revoked_at', null)
    .select('id');
}

function revokeAllForUser(userId, reason) {
  return supabase
    .from('user_sessions')
    .update({ revoked_at: new Date().toISOString(), revoked_reason: reason })
    .eq('user_id', userId)
    .is('revoked_at', null)
    .select('id');
}

module.exports = {
  createSession,
  findActiveSession,
  revokeSession,
  revokeAllForUser
};
