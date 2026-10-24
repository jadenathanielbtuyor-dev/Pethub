// ==================== PET CARE RECOMMENDATIONS ====================
// When the clinic marks an appointment Completed, PetHub records a follow-up suggestion for that pet and service:
// - from the clinic's rule for the service (species-specific first, then all species): "next Grooming suggested between
//   <date> and <date>", labelled general guidance or veterinarian-approved, with the rule's explanation;
// - or, when the clinic has no rule for that service, a "needs clinic review" note without any date (none is invented).
// Requested, rejected and cancelled appointments never produce a suggestion. One open suggestion per completed
// appointment (database unique index) and per pet and service (older ones are superseded), so reminders do not repeat.
// Owners can acknowledge or dismiss a suggestion and decide themselves whether to book; nothing is booked automatically.
// Clinic staff configure the rules and can set a pet's next date (the earlier suggestion is kept, superseded, for audit).

const careRecommendationsRepository = require('../repositories/careRecommendationsRepository');
const serviceCatalogRepository = require('../repositories/serviceCatalogRepository');
const appointmentsRepository = require('../repositories/appointmentsRepository');
const petsRepository = require('../repositories/petsRepository');
const usersRepository = require('../repositories/usersRepository');
const { logAdminActivity } = require('../utils/activityLogger');
const { isServiceBookable, isServiceAvailableForSpecies } = require('../utils/serviceCatalog');
const { isUuid, trimValue } = require('../validators/commonValidator');
const { getClinicDateValue } = require('../validators/appointmentsValidator');
const { validateRuleBody, validateOverrideBody } = require('../validators/careRecommendationValidator');
const { SERVICE_EVENT_TYPES } = require('../constants/serviceActivity');
const {
  GUIDANCE_LABELS,
  RECOMMENDATION_BASIS,
  CARE_DISCLAIMER,
  STARTING_GUIDANCE
} = require('../constants/careRecommendations');

const BASIS_LABELS = Object.freeze({
  rule: 'Suggested from the clinic\'s care schedule',
  clinic_set: 'Set by the clinic for this pet',
  needs_review: 'Ask the clinic'
});

function addDays(dateValue, days) {
  const date = new Date(`${String(dateValue).slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDate(dateValue) {
  const match = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return 'an unrecorded date';
  return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]))
    .toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
}

function describeSpeciesScope(species) {
  return species ? `${species}s only` : 'All species';
}

function describeInterval(rule) {
  const weeks = days => (days % 7 === 0 && days >= 14 ? `${days / 7} weeks` : `${days} days`);
  return rule.min_interval_days === rule.max_interval_days
    ? `about ${weeks(rule.min_interval_days)}`
    : `${weeks(rule.min_interval_days)} to ${weeks(rule.max_interval_days)}`;
}

function clip(text, max) {
  const value = String(text || '').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function isMissingTable(error) {
  return ['42P01', 'PGRST205', '42703', 'PGRST204'].includes(String(error?.code || ''));
}

// The species-specific active rule for the pet, otherwise the all-species one
function pickRule(rules, species) {
  const active = (rules || []).filter(rule => rule.is_active);
  return active.find(rule => rule.species === species) || active.find(rule => !rule.species) || null;
}

/**
 * Records the follow-up suggestion for one Completed appointment. Never throws; a failure is logged and never changes
 * the appointment. Returns { status: 'created' | 'exists' | 'skipped' | 'failed', recommendation? }.
 */
async function recordForCompletedAppointment(appointment) {
  try {
    if (!appointment || appointment.status !== 'Completed' || !appointment.pet_id || !appointment.user_id) return { status: 'skipped' };

    const existing = await careRecommendationsRepository.findBySourceAppointment(appointment.id);
    if (existing.error) throw existing.error;
    if (existing.data) return { status: 'exists', recommendation: existing.data };

    const { data: petRows, error: petError } = await petsRepository.findUserPetById(String(appointment.user_id), String(appointment.pet_id));
    if (petError) throw petError;
    const pet = Array.isArray(petRows) ? petRows[0] : null;
    if (!pet) return { status: 'skipped' };

    const serviceName = clip(appointment.service_type || 'Service', 100);
    const service = (await serviceCatalogRepository.findByName(appointment.service_type)).data || null;
    let rule = null;
    if (service) {
      const { data: rules, error: rulesError } = await careRecommendationsRepository.listActiveRulesForService(service.id);
      if (rulesError) throw rulesError;
      rule = pickRule(rules, pet.species);
    }

    const serviceDate = String(appointment.appointment_date).slice(0, 10);
    const petName = String(pet.name || 'Your pet').trim();
    const base = `${petName} had ${serviceName} on ${formatDate(serviceDate)}.`;
    const recommendation = rule
      ? {
          basis: RECOMMENDATION_BASIS.rule,
          rule_id: rule.id,
          guidance_type: rule.guidance_type,
          due_from: addDays(serviceDate, rule.min_interval_days),
          due_to: addDays(serviceDate, rule.max_interval_days),
          explanation: clip(`${base} ${rule.description}${rule.explanation ? ` ${rule.explanation}` : ''}`, 800)
        }
      : {
          basis: RECOMMENDATION_BASIS.needsReview,
          rule_id: null,
          guidance_type: null,
          due_from: null,
          due_to: null,
          explanation: clip(`${base} The clinic has not set a follow-up schedule for ${serviceName}, so PetHub does not suggest a date. Ask the clinic when ${petName} should come back.`, 800)
        };

    await careRecommendationsRepository.supersedeOpenForPetService(pet.id, serviceName);
    const inserted = await careRecommendationsRepository.insertRecommendation({
      pet_id: pet.id,
      user_id: appointment.user_id,
      service_id: service ? service.id : null,
      service_name: serviceName,
      source_appointment_id: appointment.id,
      service_date: serviceDate,
      status: 'active',
      ...recommendation
    });
    if (inserted.error) {
      if (inserted.error.code === '23505') return { status: 'exists' };
      throw inserted.error;
    }
    return { status: 'created', recommendation: inserted.data?.[0] || null };
  } catch (error) {
    console.error('Care recommendation was not recorded:', { appointment_id: appointment?.id, code: error?.code || 'unknown' });
    return { status: 'failed' };
  }
}

function mapRecommendation(row, { petNames = new Map(), staffNames = new Map(), services = new Map(), pets = new Map() } = {}) {
  const service = row.service_id ? services.get(String(row.service_id)) : null;
  const pet = pets.get(String(row.pet_id));
  const bookableNow = Boolean(service && isServiceBookable(service) && (!pet || isServiceAvailableForSpecies(service, pet.species)));
  return {
    id: row.id,
    pet_id: row.pet_id,
    pet_name: petNames.get(String(row.pet_id)) || 'Pet',
    service_id: row.service_id,
    service_name: row.service_name,
    service_date: row.service_date,
    due_from: row.due_from,
    due_to: row.due_to,
    basis: row.basis,
    basis_label: BASIS_LABELS[row.basis] || row.basis,
    guidance_type: row.guidance_type,
    guidance_label: row.guidance_type ? GUIDANCE_LABELS[row.guidance_type] : null,
    explanation: row.explanation,
    status: row.status,
    source_appointment_id: row.source_appointment_id,
    rule_id: row.rule_id,
    set_by_name: row.set_by ? staffNames.get(String(row.set_by)) || 'Clinic staff' : null,
    created_at: row.created_at,
    acknowledged_at: row.acknowledged_at,
    dismissed_at: row.dismissed_at,
    bookable_now: bookableNow,
    disclaimer: CARE_DISCLAIMER
  };
}

// ---------- Owner ----------

// GET /pets/care-recommendations: the signed-in owner's suggestions (active and acknowledged), soonest due first
async function listOwnerRecommendations(req) {
  const userId = trimValue(req.authUserId);
  try {
    const [recommendations, pets, catalog] = await Promise.all([
      careRecommendationsRepository.listVisibleForUser(userId),
      petsRepository.listByUserId(userId),
      serviceCatalogRepository.listAll()
    ]);
    if (recommendations.error) {
      if (isMissingTable(recommendations.error)) return { statusCode: 200, body: { success: true, recommendations: [], available: false } };
      throw recommendations.error;
    }
    const petRows = pets.data || [];
    const context = {
      petNames: new Map(petRows.map(pet => [String(pet.id), pet.name])),
      pets: new Map(petRows.map(pet => [String(pet.id), pet])),
      services: new Map((catalog.data || []).map(service => [String(service.id), service]))
    };
    const petFilter = trimValue(req.query?.pet_id);
    const rows = (recommendations.data || []).filter(row => !petFilter || String(row.pet_id) === petFilter);
    return { statusCode: 200, body: { success: true, available: true, recommendations: rows.map(row => mapRecommendation(row, context)), disclaimer: CARE_DISCLAIMER } };
  } catch (error) {
    console.error('Owner care recommendations error:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { success: false, error: 'Could not load care reminders.' } };
  }
}

// POST /pets/care-recommendations/:id/acknowledge | /dismiss (the owner's own suggestion only)
function ownerStatusChange(status) {
  return async (req) => {
    const id = trimValue(req.params?.id);
    if (!isUuid(id)) return { statusCode: 404, body: { success: false, error: 'Reminder not found.' } };
    try {
      const { data, error } = await careRecommendationsRepository.updateOwnStatus(id, trimValue(req.authUserId), status);
      if (error) throw error;
      if (!data || data.length === 0) return { statusCode: 404, body: { success: false, error: 'Reminder not found, or it is no longer open.' } };
      return { statusCode: 200, body: { success: true, recommendation: mapRecommendation(data[0]) } };
    } catch (error) {
      console.error('Care reminder status error:', { code: error?.code || 'unknown' });
      return { statusCode: 500, body: { success: false, error: 'Could not update this reminder.' } };
    }
  };
}

// ---------- Admin: rules ----------

function mapRule(rule, serviceNames, openCounts) {
  return {
    ...rule,
    service_name: serviceNames.get(String(rule.service_id)) || 'Service no longer listed',
    species_label: describeSpeciesScope(rule.species),
    interval_label: describeInterval(rule),
    guidance_label: GUIDANCE_LABELS[rule.guidance_type] || rule.guidance_type,
    open_recommendations: openCounts.get(String(rule.id)) || 0
  };
}

// GET /admin/care-rules: every rule, the services they can be set for, and PetHub's starting guidance (reference only)
async function listRules() {
  try {
    const [rules, catalog, open] = await Promise.all([
      careRecommendationsRepository.listRules(),
      serviceCatalogRepository.listAll(),
      careRecommendationsRepository.listOpenRecommendationRuleIds()
    ]);
    if (rules.error) {
      if (isMissingTable(rules.error)) return { statusCode: 503, body: { success: false, error: 'Care reminders are unavailable until the clinic finishes an update.' } };
      throw rules.error;
    }
    if (catalog.error) throw catalog.error;
    const serviceNames = new Map((catalog.data || []).map(service => [String(service.id), service.name]));
    const openCounts = new Map();
    (open.error ? [] : open.data || []).forEach(row => openCounts.set(String(row.rule_id), (openCounts.get(String(row.rule_id)) || 0) + 1));
    return { statusCode: 200, body: {
      success: true,
      rules: (rules.data || []).map(rule => mapRule(rule, serviceNames, openCounts)),
      services: (catalog.data || []).map(service => ({ id: service.id, name: service.name, species: service.species || [], category: service.category })),
      starting_guidance: STARTING_GUIDANCE,
      guidance_types: Object.entries(GUIDANCE_LABELS).map(([value, label]) => ({ value, label })),
      disclaimer: CARE_DISCLAIMER
    } };
  } catch (error) {
    console.error('Care rules list error:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { success: false, error: 'Could not load the care reminder rules.' } };
  }
}

function ruleSummary(rule) {
  return `${describeSpeciesScope(rule.species)}: ${describeInterval(rule)} after the service (${GUIDANCE_LABELS[rule.guidance_type]})${rule.is_active ? '' : ', disabled'}`;
}

async function saveRule(req, { existingId = null } = {}) {
  const validation = validateRuleBody(req.body, { requireVersion: Boolean(existingId) });
  if (validation.error) return validation.error;
  const adminId = trimValue(req.authUserId);

  try {
    const service = await serviceCatalogRepository.findById(validation.rule.service_id);
    if (service.error) throw service.error;
    if (!service.data) return { statusCode: 422, body: { success: false, error: 'Choose a service from the catalog.', field: 'service_id' } };
    if (validation.rule.species && !(service.data.species || []).includes(validation.rule.species)) {
      return { statusCode: 422, body: { success: false, error: `${service.data.name} is not set up for ${validation.rule.species.toLowerCase()}s. Choose all species or a species the service is for.`, field: 'species' } };
    }

    let before = null;
    let result;
    if (existingId) {
      const found = await careRecommendationsRepository.findRuleById(existingId);
      if (found.error) throw found.error;
      if (!found.data) return { statusCode: 404, body: { success: false, error: 'Rule not found.' } };
      before = found.data;
      result = await careRecommendationsRepository.updateRule(existingId, validation.expectedVersion, { ...validation.rule, updated_by: adminId });
    } else {
      result = await careRecommendationsRepository.createRule({ ...validation.rule, created_by: adminId, updated_by: adminId });
    }
    if (result.error) {
      if (result.error.code === '23505') {
        return { statusCode: 409, body: { success: false, error: `${service.data.name} already has a rule for ${describeSpeciesScope(validation.rule.species).toLowerCase()}. Edit that rule instead.`, field: 'species' } };
      }
      if (isMissingTable(result.error)) return { statusCode: 503, body: { success: false, error: 'Care reminders are unavailable until the clinic finishes an update.' } };
      throw result.error;
    }
    const saved = Array.isArray(result.data) ? result.data[0] : null;
    if (!saved) return { statusCode: 409, body: { success: false, error: 'This rule changed after the page loaded. Reload it and try again.' } };

    const eventType = !before
      ? SERVICE_EVENT_TYPES.careRuleCreated
      : before.is_active && !saved.is_active ? SERVICE_EVENT_TYPES.careRuleDisabled
        : !before.is_active && saved.is_active ? SERVICE_EVENT_TYPES.careRuleEnabled
          : SERVICE_EVENT_TYPES.careRuleUpdated;
    await logAdminActivity(adminId, 'pethub_service_catalog', service.data.id,
      `${before ? 'Changed' : 'Added'} the care reminder rule for ${service.data.name}`,
      { eventType, details: before ? `${ruleSummary(before)} → ${ruleSummary(saved)}` : ruleSummary(saved) });

    return { statusCode: before ? 200 : 201, body: {
      success: true,
      rule: mapRule(saved, new Map([[String(service.data.id), service.data.name]]), new Map()),
      note: 'Rule changes apply to services completed from now on; suggestions already made keep the dates they were given.'
    } };
  } catch (error) {
    console.error('Care rule save error:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { success: false, error: 'Could not save this rule.' } };
  }
}

const createRule = req => saveRule(req);
const updateRule = req => {
  const id = trimValue(req.params?.id);
  if (!isUuid(id)) return { statusCode: 404, body: { success: false, error: 'Rule not found.' } };
  return saveRule(req, { existingId: id });
};

// ---------- Admin: one pet's suggestions ----------

async function loadAdminContext(rows) {
  const petIds = [...new Set(rows.map(row => String(row.pet_id)))];
  const staffIds = [...new Set(rows.map(row => row.set_by).filter(Boolean).map(String))];
  const [pets, staff] = await Promise.all([
    petIds.length ? petsRepository.listNamesByIds(petIds) : Promise.resolve({ data: [] }),
    staffIds.length ? usersRepository.listNamesByIds(staffIds) : Promise.resolve({ data: [] })
  ]);
  return {
    petNames: new Map((pets.data || []).map(pet => [String(pet.id), pet.name])),
    staffNames: new Map((staff.data || []).map(user => [String(user.id), user.fullname]))
  };
}

// GET /admin/pets/:id/care-recommendations: all of a pet's suggestions, including superseded ones (audit trail)
async function listPetRecommendationsForAdmin(req) {
  const petId = trimValue(req.params?.id);
  if (!isUuid(petId)) return { statusCode: 404, body: { success: false, error: 'Pet not found.' } };
  try {
    const { data, error } = await careRecommendationsRepository.listForPet(petId);
    if (error) {
      if (isMissingTable(error)) return { statusCode: 200, body: { success: true, recommendations: [], available: false } };
      throw error;
    }
    const rows = data || [];
    const context = await loadAdminContext(rows);
    return { statusCode: 200, body: { success: true, available: true, recommendations: rows.map(row => mapRecommendation(row, context)) } };
  } catch (error) {
    console.error('Admin pet care recommendations error:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { success: false, error: 'Could not load this pet\'s care reminders.' } };
  }
}

// POST /admin/care-recommendations/:id/override: clinic staff set the pet's next date. The earlier suggestion is kept
// (superseded) and a new one records who set it, so the history can be audited.
async function overrideRecommendation(req) {
  const id = trimValue(req.params?.id);
  if (!isUuid(id)) return { statusCode: 404, body: { success: false, error: 'Reminder not found.' } };
  const validation = validateOverrideBody(req.body);
  if (validation.error) return validation.error;
  const adminId = trimValue(req.authUserId);

  try {
    const { data: current, error } = await careRecommendationsRepository.findById(id);
    if (error) throw error;
    if (!current) return { statusCode: 404, body: { success: false, error: 'Reminder not found.' } };
    if (!['active', 'acknowledged', 'dismissed'].includes(current.status)) {
      return { statusCode: 409, body: { success: false, error: 'A newer reminder replaced this one. Reload the pet\'s reminders.' } };
    }
    if (validation.dueFrom < String(current.service_date).slice(0, 10)) {
      return { statusCode: 422, body: { success: false, error: 'The suggested date must be on or after the date of the service.', field: 'due_from' } };
    }

    const superseded = await careRecommendationsRepository.supersedeById(id);
    if (superseded.error) throw superseded.error;
    if (!superseded.data?.length) {
      return { statusCode: 409, body: { success: false, error: 'This reminder just changed. Reload the pet\'s reminders.' } };
    }
    const staff = await usersRepository.listNamesByIds([adminId]);
    const staffName = staff.data?.[0]?.fullname || 'The clinic';
    const inserted = await careRecommendationsRepository.insertRecommendation({
      pet_id: current.pet_id,
      user_id: current.user_id,
      service_id: current.service_id,
      service_name: current.service_name,
      source_appointment_id: current.source_appointment_id,
      rule_id: null,
      basis: RECOMMENDATION_BASIS.clinicSet,
      guidance_type: validation.guidanceType,
      service_date: current.service_date,
      due_from: validation.dueFrom,
      due_to: validation.dueTo,
      explanation: clip(`${staffName} set this date after ${current.service_name} on ${formatDate(current.service_date)}.${validation.note ? ` ${validation.note}` : ''}`, 800),
      status: 'active',
      set_by: adminId
    });
    if (inserted.error) throw inserted.error;
    const saved = inserted.data?.[0];
    await logAdminActivity(adminId, 'pet_care_recommendations', saved.id,
      `Set the next ${current.service_name} date for a pet (${validation.dueFrom}${validation.dueTo ? ` to ${validation.dueTo}` : ''})`);
    const context = await loadAdminContext([saved]);
    return { statusCode: 200, body: { success: true, recommendation: mapRecommendation(saved, context) } };
  } catch (error) {
    console.error('Care reminder override error:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { success: false, error: 'Could not save the next date.' } };
  }
}

// POST /admin/appointments/:id/care-recommendation: records the suggestion for a Completed appointment that has none
// (for example one completed before suggestions existed). Idempotent.
async function generateForAppointment(req) {
  const id = trimValue(req.params?.id);
  if (!isUuid(id)) return { statusCode: 404, body: { success: false, error: 'Appointment not found.' } };
  try {
    const { data: appointment, error } = await appointmentsRepository.findById(id);
    if (error) throw error;
    if (!appointment) return { statusCode: 404, body: { success: false, error: 'Appointment not found.' } };
    if (appointment.status !== 'Completed') {
      return { statusCode: 409, body: { success: false, error: 'Care reminders come only from completed appointments.' } };
    }
    const result = await recordForCompletedAppointment(appointment);
    if (result.status === 'failed') return { statusCode: 500, body: { success: false, error: 'Could not record the care reminder.' } };
    if (result.status === 'skipped') return { statusCode: 409, body: { success: false, error: 'This appointment is not linked to a pet on the owner\'s account, so no reminder can be made.' } };
    const row = result.recommendation || (await careRecommendationsRepository.findBySourceAppointment(id)).data;
    const context = row ? await loadAdminContext([row]) : {};
    return { statusCode: result.status === 'created' ? 201 : 200, body: { success: true, created: result.status === 'created', recommendation: row ? mapRecommendation(row, context) : null } };
  } catch (error) {
    console.error('Care reminder generate error:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { success: false, error: 'Could not record the care reminder.' } };
  }
}

module.exports = {
  recordForCompletedAppointment,
  listOwnerRecommendations,
  acknowledgeRecommendation: ownerStatusChange('acknowledged'),
  dismissRecommendation: ownerStatusChange('dismissed'),
  listRules,
  createRule,
  updateRule,
  listPetRecommendationsForAdmin,
  overrideRecommendation,
  generateForAppointment,
  addDays,
  clinicToday: () => getClinicDateValue()
};
