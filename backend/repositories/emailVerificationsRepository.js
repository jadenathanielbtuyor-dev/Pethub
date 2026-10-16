const supabase = require('../config/supabase');

const VERIFICATION_SELECT = 'id, user_id, verification_code, expires_at, is_verified, created_at';

function findVerifiedByUserId(userId) {
  return supabase
    .from('email_verifications')
    .select('id')
    .eq('user_id', userId)
    .eq('is_verified', true)
    .limit(1);
}

function listVerifiedUserIds() {
  return supabase
    .from('email_verifications')
    .select('user_id')
    .eq('is_verified', true);
}

function countPending() {
  return supabase
    .from('email_verifications')
    .select('id', { count: 'exact', head: true })
    .eq('is_verified', false);
}

function createVerification(verification) {
  return supabase
    .from('email_verifications')
    .insert([verification]);
}

function createVerificationReturningId(verification) {
  return supabase
    .from('email_verifications')
    .insert([verification])
    .select('id');
}

function findLatestPendingByUserId(userId) {
  return supabase
    .from('email_verifications')
    .select(VERIFICATION_SELECT)
    .eq('user_id', userId)
    .eq('is_verified', false)
    .order('created_at', { ascending: false })
    .limit(1);
}

function updateById(id, values) {
  return supabase
    .from('email_verifications')
    .update(values)
    .eq('id', id)
    .select('id');
}

module.exports = {
  findVerifiedByUserId,
  listVerifiedUserIds,
  countPending,
  createVerification,
  createVerificationReturningId,
  findLatestPendingByUserId,
  updateById
};
