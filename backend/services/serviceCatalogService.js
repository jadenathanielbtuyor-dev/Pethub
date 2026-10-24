const serviceCatalogRepository = require('../repositories/serviceCatalogRepository');
const appointmentsRepository = require('../repositories/appointmentsRepository');
const { validateServiceUpdateRequest } = require('../validators/serviceCatalogValidator');
const { mapServiceForClient, listServicesForClient } = require('../utils/serviceCatalog');
const { logAdminActivity } = require('../utils/activityLogger');

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
    const { data, error } = await serviceCatalogRepository.listAll();
    if (error) return failedCatalogLoad(error);
    // listServicesForClient re-sorts the rows, so each service's version is looked up by id, not by position
    const rowsById = new Map((data || []).map(row => [String(row.id), row]));
    // Booked services keep their name (see updateService); the settings form shows the name as locked for them
    const { data: bookedTypes, error: bookedError } = await appointmentsRepository.listServiceTypes();
    const bookedNames = new Set(bookedError ? [] : (bookedTypes || []).map(row => String(row.service_type || '')));
    const services = listServicesForClient(data || []).map(service => ({
      ...service,
      version: rowsById.get(service.id)?.version,
      updated_at: rowsById.get(service.id)?.updated_at || null,
      has_appointments: bookedError ? null : bookedNames.has(service.name)
    }));
    return { statusCode: 200, body: { success: true, services } };
  } catch (error) {
    return failedCatalogLoad(error);
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
      `Updated service configuration for ${existing.data.name}`
    );

    return { statusCode: 200, body: { success: true, service: mapServiceForClient(updated), version: updated.version, updated_at: updated.updated_at } };
  } catch (error) {
    console.error('Service configuration update failed:', { code: error?.code || 'unknown' });
    return { statusCode: 500, body: { success: false, error: 'Could not save this service configuration.' } };
  }
}

module.exports = {
  listServices,
  listAdminServices,
  updateService
};
