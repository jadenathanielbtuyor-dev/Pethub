const supabase = require('../config/supabase');

const USER_AUTH_SELECT = 'id, fullname, email, password, role, is_verified, created_at';
const USER_PUBLIC_SELECT = 'id, fullname, email, role, is_verified, created_at';
const USER_ADMIN_LIST_SELECT = 'id, fullname, email, role, created_at, is_verified';
const USER_NAME_SELECT = 'id, fullname';
// Personal and contact details (constants/userProfile.js PROFILE_COLUMNS). Deliberately not part of the selects above:
// those keep working on a database where database/migrations/2026-10-20_users_profile_fields.sql is not applied yet.
const USER_PROFILE_SELECT = 'id, phone_number, date_of_birth, gender, address_line, barangay, city_municipality, province, postal_code';

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

// Stores a new password hash (utils/passwordHash.js, as registration does); .select lets callers confirm a row changed
function updatePassword(userId, password) {
  return supabase
    .from('users')
    .update({ password })
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

function findProfileById(userId) {
  return supabase
    .from('users')
    .select(USER_PROFILE_SELECT)
    .eq('id', userId)
    .limit(1);
}

// The signed-in customer's own name and personal details (PUT /auth/profile), in one update of their own row. Returns
// the public account fields and the details, never the password.
function updateProfile(userId, details) {
  return supabase
    .from('users')
    .update(details)
    .eq('id', userId)
    .select(`${USER_PUBLIC_SELECT}, ${USER_PROFILE_SELECT.replace(/^id, /, '')}`);
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

function countByRole(role) {
  return supabase
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('role', role);
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
  updatePassword,
  findStatusById,
  findProfileById,
  updateProfile,
  listVerificationStatusesWithCount,
  listForDashboardOverview,
  listAdminUsers,
  findRoleAndVerificationById,
  findForRoleUpdate,
  countByRole,
  updateRole,
  listNamesByIds
};
