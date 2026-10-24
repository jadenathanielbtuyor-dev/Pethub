const systemSettingsRepository = require('../repositories/systemSettingsRepository');
const { CLINIC_CONTACT_FIELDS, CLINIC_CONTACT_KEYS } = require('../constants/clinic');
const { validateClinicContactUpdate } = require('../validators/clinicSettingsValidator');
const { normalizeContactNumber } = require('../validators/authValidator');
const { logAdminActivity } = require('../utils/activityLogger');

function emptyDetails() {
  return Object.fromEntries(Object.keys(CLINIC_CONTACT_FIELDS).map(name => [name, null]));
}

function toDetails(rows = []) {
  const byKey = new Map((rows || []).map(row => [row.setting_key, row]));
  const details = emptyDetails();
  let updatedAt = null;
  Object.entries(CLINIC_CONTACT_FIELDS).forEach(([name, field]) => {
    const row = byKey.get(field.key);
    const value = typeof row?.setting_value === 'string' ? row.setting_value.trim() : '';
    details[name] = value || null;
    if (row?.updated_at && (!updatedAt || row.updated_at > updatedAt)) updatedAt = row.updated_at;
  });
  return { details, updatedAt };
}

// The tel: form of the clinic's number (+63...), for links; the number itself is shown as the clinic typed it
function withPhoneLink(details) {
  return { ...details, phone_link: details.phone ? normalizeContactNumber(details.phone) || null : null };
}

/**
 * The clinic's contact details for emails and pages: { phone, email, address, hours } with null for anything not
 * entered. Never throws; if the settings cannot be read, every value is null and `available` is false.
 */
async function getClinicContactDetails() {
  try {
    const { data, error } = await systemSettingsRepository.listByKeys(CLINIC_CONTACT_KEYS);
    if (error) return { ...emptyDetails(), available: false };
    return { ...toDetails(data).details, available: true };
  } catch (error) {
    return { ...emptyDetails(), available: false };
  }
}

// GET /contact/clinic-info (public): the details the clinic has published, for the Contact page
async function getPublicClinicInfo() {
  const { available, ...details } = await getClinicContactDetails();
  if (!available) return { statusCode: 503, body: { success: false, error: 'Clinic contact details are unavailable right now.' } };
  const configured = Object.values(details).some(Boolean);
  return { statusCode: 200, body: { success: true, configured, clinic: withPhoneLink(details) } };
}

// GET /admin/clinic-settings
async function getAdminClinicSettings() {
  try {
    const { data, error } = await systemSettingsRepository.listByKeys(CLINIC_CONTACT_KEYS);
    if (error) {
      console.error('Clinic settings query failed:', { code: error.code || 'unknown' });
      return { statusCode: 500, body: { success: false, error: 'Could not load the clinic contact details.' } };
    }
    const { details, updatedAt } = toDetails(data);
    return { statusCode: 200, body: { success: true, clinic: details, updated_at: updatedAt } };
  } catch (error) {
    return { statusCode: 500, body: { success: false, error: 'Could not load the clinic contact details.' } };
  }
}

// PUT /admin/clinic-settings { phone, email, address, hours }: all four are saved together; a blank value is cleared
async function updateClinicSettings(req) {
  const validation = validateClinicContactUpdate(req.body);
  if (validation.error) return validation.error;

  try {
    const entries = Object.entries(CLINIC_CONTACT_FIELDS).map(([name, field]) => ({ key: field.key, value: validation.values[name] }));
    const { data, error } = await systemSettingsRepository.upsertValues(entries);
    if (error) {
      console.error('Clinic settings update failed:', { code: error.code || 'unknown' });
      return { statusCode: 500, body: { success: false, error: 'Could not save the clinic contact details.' } };
    }
    const savedRows = Array.isArray(data) ? data : [];
    const targetId = savedRows.find(row => row && row.id)?.id;
    if (targetId) await logAdminActivity(req.authUserId, 'system_settings', targetId, 'Updated the clinic contact details');
    const { details, updatedAt } = toDetails(savedRows);
    return { statusCode: 200, body: { success: true, clinic: details, updated_at: updatedAt } };
  } catch (error) {
    console.error('Clinic settings update failed:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { success: false, error: 'Could not save the clinic contact details.' } };
  }
}

module.exports = {
  getClinicContactDetails,
  getPublicClinicInfo,
  getAdminClinicSettings,
  updateClinicSettings
};
