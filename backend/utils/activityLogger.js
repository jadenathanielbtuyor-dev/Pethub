const activityLogsRepository = require('../repositories/activityLogsRepository');
const { hasValue } = require('../validators/commonValidator');
const logger = require('./logger');

function getAdminActorId(req = {}) {
  return req.authUserId || req.query?.user_id || req.headers?.['x-user-id'] || req.body?.user_id;
}

async function logUserActivity(userId, action, details = '') {
  if (!hasValue(userId) || !hasValue(action)) return;

  try {
    const { error } = await activityLogsRepository.insertActivityLog({
      user_id: String(userId).trim(),
      action: String(action).trim(),
      details: String(details || '')
    });

    if (error) {
      logger.warn('activity.user_log_failed', { action, user_id: userId, error: error.message || error });
    }
  } catch (error) {
    logger.warn('activity.user_log_failed', { action, user_id: userId, error: error.message || error });
  }
}

// eventType: a machine-readable type (activity_logs.event_type, e.g. constants/serviceActivity.js); details: what changed
async function logAdminActivity(adminId, targetTable, targetId, action, { eventType = null, details = null } = {}) {
  if (!hasValue(adminId) || !hasValue(targetTable) || !hasValue(targetId) || !hasValue(action)) {
    logger.warn('activity.admin_log_skipped', { action, targetTable, targetId });
    return;
  }

  try {
    const { error } = await activityLogsRepository.insertActivityLog({
      actor_id: String(adminId).trim(),
      user_id: String(adminId).trim(),
      target_table: String(targetTable).trim(),
      target_id: String(targetId).trim(),
      action: String(action).trim(),
      ...(eventType ? { event_type: eventType } : {}),
      ...(details ? { details: String(details).slice(0, 1000) } : {})
    });

    if (error) {
      logger.warn('activity.admin_log_failed', { action, targetTable, targetId, error: error.message || error });
    }
  } catch (error) {
    logger.warn('activity.admin_log_failed', { action, targetTable, targetId, error: error.message || error });
  }
}

module.exports = {
  getAdminActorId,
  logUserActivity,
  logAdminActivity
};
