const usersRepository = require('../repositories/usersRepository');
const emailVerificationsRepository = require('../repositories/emailVerificationsRepository');
const { hasValue, isVerifiedValue } = require('../validators/commonValidator');

async function hasVerifiedEmailRecord(userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) return false;

  const { data, error } = await emailVerificationsRepository.findVerifiedByUserId(normalizedUserId);
  if (error) throw error;

  return Array.isArray(data) && data.length > 0;
}

async function isUserVerified(userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!hasValue(normalizedUserId)) return false;

  const { data: users, error } = await usersRepository.findStatusById(normalizedUserId);
  if (error) throw error;

  const user = Array.isArray(users) && users.length > 0 ? users[0] : null;
  if (user && isVerifiedValue(user.is_verified)) return true;

  return hasVerifiedEmailRecord(normalizedUserId);
}

async function isAdminVerified(adminId) {
  const normalizedAdminId = String(adminId || '').trim();
  if (!hasValue(normalizedAdminId)) return false;

  const { data: users, error } = await usersRepository.findRoleAndVerificationById(normalizedAdminId);
  if (error) throw error;

  if (!Array.isArray(users) || users.length === 0) return false;

  const admin = users[0];
  if (String(admin.role || '').toLowerCase() !== 'admin') return false;
  if (isVerifiedValue(admin.is_verified)) return true;

  return hasVerifiedEmailRecord(normalizedAdminId);
}

async function getVerifiedTotals(users) {
  const verifiedIds = new Set();
  const allUsers = Array.isArray(users) ? users : [];

  allUsers.forEach(user => {
    if (user && user.id != null && isVerifiedValue(user.is_verified)) {
      verifiedIds.add(String(user.id));
    }
  });

  const { data: verifiedRows, error } = await emailVerificationsRepository.listVerifiedUserIds();
  if (!error && Array.isArray(verifiedRows)) {
    verifiedRows.forEach(row => {
      if (row && row.user_id != null) {
        verifiedIds.add(String(row.user_id));
      }
    });
  }

  return {
    verifiedUsers: verifiedIds.size,
    unverifiedUsers: allUsers.filter(user => !verifiedIds.has(String(user.id))).length
  };
}

module.exports = {
  hasVerifiedEmailRecord,
  isUserVerified,
  isAdminVerified,
  getVerifiedTotals
};
