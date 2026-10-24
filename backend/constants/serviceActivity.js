// Types of service-catalog activity (activity_logs.event_type, database/migrations/2026-10-24_multi_pet_booking_and_care_recommendations.sql)
// and how the admin Service activity history names them. Rows recorded before types existed have event_type NULL.

const SERVICE_EVENT_TYPES = Object.freeze({
  created: 'service_created',
  updated: 'service_updated',
  activated: 'service_activated',
  deactivated: 'service_deactivated',
  careRuleCreated: 'care_rule_created',
  careRuleUpdated: 'care_rule_updated',
  careRuleEnabled: 'care_rule_enabled',
  careRuleDisabled: 'care_rule_disabled'
});

const SERVICE_EVENT_LABELS = Object.freeze({
  [SERVICE_EVENT_TYPES.created]: 'Service added',
  [SERVICE_EVENT_TYPES.updated]: 'Settings changed',
  [SERVICE_EVENT_TYPES.activated]: 'Online booking turned on',
  [SERVICE_EVENT_TYPES.deactivated]: 'Online booking turned off',
  [SERVICE_EVENT_TYPES.careRuleCreated]: 'Care reminder rule added',
  [SERVICE_EVENT_TYPES.careRuleUpdated]: 'Care reminder rule changed',
  [SERVICE_EVENT_TYPES.careRuleEnabled]: 'Care reminder rule enabled',
  [SERVICE_EVENT_TYPES.careRuleDisabled]: 'Care reminder rule disabled'
});

// Shown for entries saved before activity types and change details were recorded
const LEGACY_SERVICE_EVENT_LABEL = 'Settings changed (details were not recorded then)';

const SERVICE_ACTIVITY_PAGE_SIZE = 15;
const SERVICE_ACTIVITY_MAX_PAGE_SIZE = 50;

module.exports = {
  SERVICE_EVENT_TYPES,
  SERVICE_EVENT_LABELS,
  LEGACY_SERVICE_EVENT_LABEL,
  SERVICE_ACTIVITY_PAGE_SIZE,
  SERVICE_ACTIVITY_MAX_PAGE_SIZE
};
