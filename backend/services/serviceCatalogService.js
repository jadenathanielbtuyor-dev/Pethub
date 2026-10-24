const serviceCatalogRepository = require('../repositories/serviceCatalogRepository');
const appointmentsRepository = require('../repositories/appointmentsRepository');
const activityLogsRepository = require('../repositories/activityLogsRepository');
const usersRepository = require('../repositories/usersRepository');
const { validateServiceUpdateRequest, validateServiceCreateRequest, buildServiceKey } = require('../validators/serviceCatalogValidator');
const { mapServiceForClient, listServicesForClient } = require('../utils/serviceCatalog');
const { logAdminActivity } = require('../utils/activityLogger');
const { parsePageQuery, fetchPage } = require('../utils/pagination');
const { isUuid, trimValue } = require('../validators/commonValidator');
const { SERVICE_CATEGORIES } = require('../constants/services');
const {
  SERVICE_EVENT_TYPES,
  SERVICE_EVENT_LABELS,
  LEGACY_SERVICE_EVENT_LABEL,
  SERVICE_ACTIVITY_PAGE_SIZE,
  SERVICE_ACTIVITY_MAX_PAGE_SIZE
} = require('../constants/serviceActivity');

function isMissingServiceCatalogTable(error) {
  return ['42P01', 'PGRST205'].includes(String(error?.code || ''));
}

function configurationUnavailable() {
  return { statusCode: 503, body: { success: false, error: 'Service configuration is unavailable until the reviewed database migration is applied.' } };
}

function failedCatalogLoad(error) {
  if (isMissingServiceCatalogTable(error)) return configurationUnavailable();
  console.error('Service catalog query failed:', { code: error?.code || 'unknown' });
  return { statusCode: 500, body: { success: false, error: 'Could not load the service catalog.' } };
}

async function listServices() {
  try {
    const { data, error } = await serviceCatalogRepository.listAll();
    if (error) return failedCatalogLoad(error);
    return { statusCode: 200, body: { success: true, services: listServicesForClient(data || []), species: ['Dog', 'Cat'] } };
  } catch (error) {
    return failedCatalogLoad(error);
  }
}

async function listAdminServices() {
  try {
    // Booked services keep their name (see updateService); the settings form shows the name as locked for them, and the
    // list says how many appointments depend on each service (deactivating never touches them)
    const [{ data, error }, { data: bookedTypes, error: bookedError }] = await Promise.all([
      serviceCatalogRepository.listAll(),
      appointmentsRepository.listServiceTypes()
    ]);
    if (error) return failedCatalogLoad(error);
    // listServicesForClient re-sorts the rows, so each service's version is looked up by id, not by position
    const rowsById = new Map((data || []).map(row => [String(row.id), row]));
    const bookedCounts = new Map();
    (bookedError ? [] : bookedTypes || []).forEach(row => {
      const name = String(row.service_type || '');
      bookedCounts.set(name, (bookedCounts.get(name) || 0) + 1);
    });
    const services = listServicesForClient(data || []).map(service => ({
      ...service,
      version: rowsById.get(service.id)?.version,
      updated_at: rowsById.get(service.id)?.updated_at || null,
      has_appointments: bookedError ? null : bookedCounts.has(service.name),
      appointment_count: bookedError ? null : bookedCounts.get(service.name) || 0
    }));
    return { statusCode: 200, body: { success: true, services, categories: SERVICE_CATEGORIES } };
  } catch (error) {
    return failedCatalogLoad(error);
  }
}

const FIELD_LABELS = Object.freeze({
  name: 'Name',
  description: 'Description',
  category: 'Category',
  species: 'Species',
  duration_minutes: 'Duration',
  online_booking_enabled: 'Online booking',
  display_order: 'Display order'
});

function describeValue(field, value) {
  if (field === 'duration_minutes') return Number.isInteger(value) ? `${value} min` : 'not set';
  if (field === 'online_booking_enabled') return value ? 'on' : 'off';
  if (field === 'species') return Array.isArray(value) && value.length ? value.join(', ') : 'none';
  if (field === 'category') return SERVICE_CATEGORIES[value] || String(value || '');
  if (field === 'description') return value ? `"${String(value).slice(0, 60)}${String(value).length > 60 ? '…' : ''}"` : 'empty';
  return value === null || value === undefined || value === '' ? 'not set' : String(value);
}

// "Duration: not set → 30 min; Online booking: off → on" for the fields that actually changed
function describeChanges(before, after) {
  return Object.keys(FIELD_LABELS)
    .filter(field => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null))
    .map(field => `${FIELD_LABELS[field]}: ${describeValue(field, before[field])} → ${describeValue(field, after[field])}`)
    .join('; ');
}

function eventTypeForUpdate(before, after) {
  if (before.online_booking_enabled !== true && after.online_booking_enabled === true) return SERVICE_EVENT_TYPES.activated;
  if (before.online_booking_enabled === true && after.online_booking_enabled !== true) return SERVICE_EVENT_TYPES.deactivated;
  return SERVICE_EVENT_TYPES.updated;
}

// POST /admin/services: adds a service to the catalog (a database row, available to the booking page at once). It can
// be switched on only with a duration and species, like an edit.
async function createService(req) {
  const validation = validateServiceCreateRequest(req.body, req.authUserId);
  if (validation.error) return validation.error;

  try {
    const base = buildServiceKey(validation.service.name);
    let result = await serviceCatalogRepository.create({ ...validation.service, service_key: base });
    // Two names can share a key ("Bath" and "Bath!"): the name itself is unique, so a key clash gets a short suffix
    if (result.error?.code === '23505' && /service_key/.test(String(result.error.message || ''))) {
      result = await serviceCatalogRepository.create({ ...validation.service, service_key: `${base.slice(0, 52)}-${Date.now().toString(36).slice(-6)}` });
    }
    if (result.error) {
      if (isMissingServiceCatalogTable(result.error)) return configurationUnavailable();
      if (result.error.code === '23505') {
        return { statusCode: 409, body: { success: false, error: 'A service with this name already exists.', field: 'name' } };
      }
      console.error('Service create failed:', { code: result.error?.code || 'unknown' });
      return { statusCode: 500, body: { success: false, error: 'Could not add this service.' } };
    }
    const created = Array.isArray(result.data) ? result.data[0] : null;
    if (!created) return { statusCode: 500, body: { success: false, error: 'Could not add this service.' } };

    const details = describeChanges({}, created);
    await logAdminActivity(validation.adminUserId, 'pethub_service_catalog', created.id, `Added service ${created.name}`, {
      eventType: SERVICE_EVENT_TYPES.created,
      details
    });
    return { statusCode: 201, body: { success: true, service: mapServiceForClient(created), version: created.version, updated_at: created.updated_at } };
  } catch (error) {
    console.error('Service create failed:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { success: false, error: 'Could not add this service.' } };
  }
}

async function updateService(req) {
  const validation = validateServiceUpdateRequest(req.params, req.body, req.authUserId);
  if (validation.error) return validation.error;

  try {
    const existing = await serviceCatalogRepository.findById(validation.serviceId);
    if (existing.error) return failedCatalogLoad(existing.error);
    if (!existing.data) return { statusCode: 404, body: { success: false, error: 'Service not found.' } };

    // Appointments keep the service name as text, so renaming a service that has been booked would detach its
    // appointments from it (analytics, duplicate checks and the admin service filter match by name)
    if (validation.changes.name !== existing.data.name) {
      const booked = await appointmentsRepository.countByServiceType(existing.data.name);
      if (booked.error) throw booked.error;
      if ((booked.count || 0) > 0) {
        return { statusCode: 409, body: {
          success: false,
          field: 'name',
          error: `${existing.data.name} already has appointments, so its name cannot be changed. Edit its description instead.`
        } };
      }
    }

    const result = await serviceCatalogRepository.updateById(
      validation.serviceId,
      validation.expectedVersion,
      validation.changes
    );
    if (result.error) {
      if (isMissingServiceCatalogTable(result.error)) return configurationUnavailable();
      if (result.error.code === '23505') {
        return { statusCode: 409, body: { success: false, error: 'A service with this name already exists.', field: 'name' } };
      }
      console.error('Service configuration update failed:', { code: result.error?.code || 'unknown' });
      return { statusCode: 500, body: { success: false, error: 'Could not save this service configuration.' } };
    }

    const updated = Array.isArray(result.data) ? result.data[0] : null;
    if (!updated) {
      return { statusCode: 409, body: { success: false, error: 'This service changed after the page loaded. Reload it and try again.' } };
    }

    await logAdminActivity(
      validation.adminUserId,
      'pethub_service_catalog',
      validation.serviceId,
      `Updated service configuration for ${existing.data.name}`,
      { eventType: eventTypeForUpdate(existing.data, updated), details: describeChanges(existing.data, updated) || 'Saved without changes' }
    );

    return { statusCode: 200, body: { success: true, service: mapServiceForClient(updated), version: updated.version, updated_at: updated.updated_at } };
  } catch (error) {
    console.error('Service configuration update failed:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { success: false, error: 'Could not save this service configuration.' } };
  }
}

const ACTIVITY_TYPES = new Set([...Object.values(SERVICE_EVENT_TYPES), 'legacy']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Clinic dates (Asia/Manila, UTC+8, no daylight saving) to timestamps: from the start of `from` up to the end of `to`
function clinicDayStartIso(dateValue, addDays = 0) {
  const start = new Date(`${dateValue}T00:00:00+08:00`);
  if (!Number.isFinite(start.getTime())) return '';
  return new Date(start.getTime() + addDays * 24 * 60 * 60 * 1000).toISOString();
}

function validateActivityQuery(query = {}) {
  const serviceId = trimValue(query.service_id);
  if (serviceId && !isUuid(serviceId)) return { error: 'Choose a valid service.', field: 'service_id' };
  const eventType = trimValue(query.type);
  if (eventType && !ACTIVITY_TYPES.has(eventType)) return { error: 'Choose a valid activity type.', field: 'type' };
  const actorId = trimValue(query.admin_id);
  if (actorId && !isUuid(actorId)) return { error: 'Choose a valid administrator.', field: 'admin_id' };
  const from = trimValue(query.from);
  const to = trimValue(query.to);
  if ((from && !DATE_PATTERN.test(from)) || (to && !DATE_PATTERN.test(to))) return { error: 'Dates must be YYYY-MM-DD.', field: from && !DATE_PATTERN.test(from) ? 'from' : 'to' };
  if (from && to && from > to) return { error: 'The start date must be on or before the end date.', field: 'from' };
  return {
    filters: {
      serviceId,
      eventType,
      actorId,
      fromIso: from ? clinicDayStartIso(from) : '',
      toIso: to ? clinicDayStartIso(to, 1) : ''
    },
    echo: { service_id: serviceId, type: eventType, admin_id: actorId, from, to }
  };
}

// GET /admin/services/activity: the service catalog's activity history, newest first, one page at a time, filtered in
// the database by service, type, administrator and clinic date range
async function listServiceActivity(req) {
  const validation = validateActivityQuery(req.query);
  if (validation.error) return { statusCode: 400, body: { success: false, error: validation.error, field: validation.field } };
  const { page, pageSize } = parsePageQuery(req.query, { defaultSize: SERVICE_ACTIVITY_PAGE_SIZE, maxSize: SERVICE_ACTIVITY_MAX_PAGE_SIZE });

  try {
    // The administrators filter list does not depend on the page, so both are read at once
    const [result, actorRows] = await Promise.all([
      fetchPage(range => activityLogsRepository.listServiceActivityPage(validation.filters, range), page, pageSize),
      activityLogsRepository.listServiceActivityActors()
    ]);
    if (result.error) throw result.error;

    const serviceIds = [...new Set(result.rows.map(row => row.target_id).filter(Boolean).map(String))];
    const actorIds = [...new Set([...result.rows.map(row => row.actor_id), ...(actorRows.data || []).map(row => row.actor_id)].filter(Boolean).map(String))];
    const [services, actors] = await Promise.all([
      serviceIds.length ? serviceCatalogRepository.listNamesByIds(serviceIds) : Promise.resolve({ data: [] }),
      actorIds.length ? usersRepository.listNamesByIds(actorIds) : Promise.resolve({ data: [] })
    ]);
    const serviceNames = new Map((services.data || []).map(row => [String(row.id), row.name]));
    const actorNames = new Map((actors.data || []).map(row => [String(row.id), row.fullname || 'Administrator']));

    return { statusCode: 200, body: {
      success: true,
      entries: result.rows.map(row => ({
        id: row.id,
        created_at: row.created_at,
        service_id: row.target_id,
        service_name: serviceNames.get(String(row.target_id)) || 'Service no longer listed',
        event_type: row.event_type || 'legacy',
        event_label: row.event_type ? SERVICE_EVENT_LABELS[row.event_type] || row.event_type : LEGACY_SERVICE_EVENT_LABEL,
        admin_id: row.actor_id,
        admin_name: actorNames.get(String(row.actor_id)) || 'Account no longer listed',
        summary: row.action,
        details: row.details || null
      })),
      ...result.info,
      filters: validation.echo,
      admins: [...new Set((actorRows.data || []).map(row => String(row.actor_id)).filter(Boolean))]
        .map(id => ({ id, name: actorNames.get(id) || 'Account no longer listed' })),
      types: Object.entries(SERVICE_EVENT_LABELS).map(([value, label]) => ({ value, label })).concat([{ value: 'legacy', label: LEGACY_SERVICE_EVENT_LABEL }])
    } };
  } catch (error) {
    console.error('Service activity query failed:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { success: false, error: 'Could not load the service activity.' } };
  }
}

module.exports = {
  listServices,
  listAdminServices,
  createService,
  updateService,
  listServiceActivity,
  describeChanges
};
