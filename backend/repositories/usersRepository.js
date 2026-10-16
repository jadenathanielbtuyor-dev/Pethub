const supabase = require('../config/supabase');

const USER_AUTH_SELECT = 'id, fullname, email, password, role, is_verified, created_at';
const USER_PUBLIC_SELECT = 'id, fullname, email, role, is_verified, created_at';
const USER_ADMIN_LIST_SELECT = 'id, fullname, email, role, created_at, is_verified';
const USER_NAME_SELECT = 'id, fullname';

function findByEmailForLogin(email) {
  return supabase
    .from('users')
    .select(USER_AUTH_SELECT)
    .eq('email', email)
    .limit(1);
}

function findIdsByEmail(email) {
  return supabase
    .from('users')
    .select('id')
    .eq('email', email);
}

function createUser(user) {
  return supabase
    .from('users')
    .insert([user])
    .select(USER_PUBLIC_SELECT);
}

function findByEmailForVerification(email) {
  return supabase
    .from('users')
    .select('id, fullname, email, is_verified')
    .eq('email', email)
    .limit(1);
}

function updateVerificationStatus(userId, isVerified = true) {
  return supabase
    .from('users')
    .update({ is_verified: isVerified })
    .eq('id', userId)
    .select('id');
}

function findStatusById(userId) {
  return supabase
    .from('users')
    .select(USER_PUBLIC_SELECT)
    .eq('id', userId)
    .limit(1);
}

function listVerificationStatusesWithCount() {
  return supabase
    .from('users')
    .select('id, is_verified', { count: 'exact' });
}

function listForDashboardOverview() {
  return supabase
    .from('users')
    .select(USER_PUBLIC_SELECT)
    .order('created_at', { ascending: false });
}

function listAdminUsers() {
  return supabase
    .from('users')
    .select(USER_ADMIN_LIST_SELECT)
    .order('created_at', { ascending: false });
}

function findRoleAndVerificationById(userId) {
  return supabase
    .from('users')
    .select('id, role, is_verified')
    .eq('id', userId)
    .limit(1);
}

function findForRoleUpdate(userId) {
  return supabase
    .from('users')
    .select(USER_PUBLIC_SELECT)
    .eq('id', userId)
    .maybeSingle();
}

function updateRole(userId, role) {
  return supabase
    .from('users')
    .update({ role })
    .eq('id', userId)
    .select(USER_PUBLIC_SELECT)
    .maybeSingle();
}

function listNamesByIds(userIds) {
  return supabase
    .from('users')
    .select(USER_NAME_SELECT)
    .in('id', userIds);
}

module.exports = {
  findByEmailForLogin,
  findIdsByEmail,
  createUser,
  findByEmailForVerification,
  updateVerificationStatus,
  findStatusById,
  listVerificationStatusesWithCount,
  listForDashboardOverview,
  listAdminUsers,
  findRoleAndVerificationById,
  findForRoleUpdate,
  updateRole,
  listNamesByIds
};
