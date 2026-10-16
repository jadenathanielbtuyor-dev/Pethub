const { getSupabaseAdmin, isSupabaseAdminConfigured } = require('../config/supabaseAdmin');

const PASSWORD_RESET_SELECT = 'id, user_id, reset_token, expires_at, used_at, attempts, created_at';

// Reset rows are only read and written with the server-only service-role client (config/supabaseAdmin.js),
// so the table can be closed to the public anon key (RLS enabled, no policies) without affecting this feature.
function isConfigured() {
  return isSupabaseAdminConfigured();
}

function findLatestByUserId(userId) {
  return getSupabaseAdmin()
    .from('password_resets')
    .select(PASSWORD_RESET_SELECT)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);
}

// Retires the user's open codes created before `createdBefore` (the start of the resend cooldown), so only the newest
// code can be used. Newer codes are left alone, so a request racing this one can't retire the code it just created.
function invalidateOpenByUserId(userId, usedAt, createdBefore) {
  return getSupabaseAdmin()
    .from('password_resets')
    .update({ used_at: usedAt })
    .eq('user_id', userId)
    .is('used_at', null)
    .lt('created_at', createdBefore);
}

// With the one-open-code-per-user index, this fails with 23505 if a parallel request already created the user's code
function createReset(reset) {
  return getSupabaseAdmin()
    .from('password_resets')
    .insert([reset]);
}

// Compare-and-set: counts one attempt only if the row still has the attempt count the caller read,
// so concurrent requests can never be granted more attempts than the code allows.
function reserveAttempt(id, currentAttempts, now) {
  return getSupabaseAdmin()
    .from('password_resets')
    .update({ attempts: currentAttempts + 1 })
    .eq('id', id)
    .eq('attempts', currentAttempts)
    .is('used_at', null)
    .gt('expires_at', now)
    .select('id');
}

// Marks the code used only if it is still open and unexpired; returns no row if another request used it first
function consumeById(id, usedAt) {
  return getSupabaseAdmin()
    .from('password_resets')
    .update({ used_at: usedAt })
    .eq('id', id)
    .is('used_at', null)
    .gt('expires_at', usedAt)
    .select('id');
}

// Reopens a code after a password update the database definitely rejected. It matches only the exact used_at this
// request wrote in consumeById, so a code used or retired by any other request is never reopened.
function restoreConsumed(id, usedAt) {
  return getSupabaseAdmin()
    .from('password_resets')
    .update({ used_at: null })
    .eq('id', id)
    .eq('used_at', usedAt)
    .select('id');
}

module.exports = {
  isConfigured,
  findLatestByUserId,
  invalidateOpenByUserId,
  createReset,
  reserveAttempt,
  consumeById,
  restoreConsumed
};
