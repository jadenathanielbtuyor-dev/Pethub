const {
  SERVICE_SPECIES,
  SERVICE_CATEGORIES,
  LEGACY_SERVICE_NAMES
} = require('../constants/services');

const EARLIER_SERVICE_SUFFIX = '(earlier service)';
const NOT_RECORDED_LABEL = 'Service not recorded';
const MIN_SERVICE_DURATION_MINUTES = 5;
const MAX_SERVICE_DURATION_MINUTES = 480;

function normalizeSpecies(value) {
  const text = String(value || '').trim().toLowerCase();
  return SERVICE_SPECIES.find(species => species.toLowerCase() === text) || '';
}

function describeSpecies(speciesList = []) {
  const words = speciesList.map(species => `${String(species).toLowerCase()}s`);
  if (words.length > 1) return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return words[0] || '';
}

function isServiceAvailableForSpecies(service, species) {
  const normalized = normalizeSpecies(species);
  return Boolean(service && normalized && Array.isArray(service.species) && service.species.includes(normalized));
}

function getServiceUnavailableReason(service) {
  if (!service) return 'This service is not listed in the current catalog.';
  if (service.online_booking_enabled !== true) return 'Online booking is disabled for this service.';
  if (!Number.isInteger(service.duration_minutes)
      || service.duration_minutes < MIN_SERVICE_DURATION_MINUTES
      || service.duration_minutes > MAX_SERVICE_DURATION_MINUTES) {
    return 'A clinic-confirmed duration is required before this service can be booked online.';
  }
  if (!Array.isArray(service.species) || service.species.length === 0) {
    return 'Applicable species need clinic confirmation before this service can be booked online.';
  }
  return '';
}

function isServiceBookable(service) {
  return getServiceUnavailableReason(service) === '';
}

function mapServiceForClient(service) {
  const species = Array.isArray(service.species) ? [...service.species] : [];
  return {
    id: String(service.id),
    service_key: service.service_key,
    name: service.name,
    category: service.category,
    category_label: SERVICE_CATEGORIES[service.category] || service.category,
    description: service.description || '',
    species,
    duration_minutes: Number.isInteger(service.duration_minutes) ? service.duration_minutes : null,
    online_booking_enabled: service.online_booking_enabled === true,
    bookable: isServiceBookable(service),
    unavailable_reason: getServiceUnavailableReason(service),
    display_order: service.display_order
  };
}

function listServicesForClient(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .slice()
    .sort((first, second) => (Number(first.display_order) - Number(second.display_order)) || String(first.name).localeCompare(String(second.name)))
    .map(mapServiceForClient);
}

function findServiceByIdOrName(rows = [], { serviceId = '', serviceName = '' } = {}) {
  const id = String(serviceId || '').trim();
  const name = String(serviceName || '').trim();
  return (rows || []).find(service => (id && String(service.id) === id)
    || (!id && name && String(service.name) === name)) || null;
}

function countServicesForAnalytics(serviceTypes, serviceRows = []) {
  const counts = new Map((serviceRows || []).map(entry => [entry.name, 0]));
  const earlier = new Map();
  (serviceTypes || []).forEach(value => {
    const name = String(value || '').trim();
    if (counts.has(name)) counts.set(name, counts.get(name) + 1);
    else {
      const label = name ? `${name} ${EARLIER_SERVICE_SUFFIX}` : NOT_RECORDED_LABEL;
      earlier.set(label, (earlier.get(label) || 0) + 1);
    }
  });
  const earlierLabels = [...earlier.keys()].sort((first, second) => first.localeCompare(second));
  return {
    labels: [...counts.keys(), ...earlierLabels],
    values: [...counts.values(), ...earlierLabels.map(label => earlier.get(label))]
  };
}

function isCheckupService(serviceType, serviceRows = []) {
  const name = String(serviceType || '').trim();
  if (LEGACY_SERVICE_NAMES.includes(name) && name === 'Checkup') return true;
  return (serviceRows || []).some(service => service.service_key === 'dog-cat-full-check-up' && service.name === name);
}

module.exports = {
  EARLIER_SERVICE_SUFFIX,
  NOT_RECORDED_LABEL,
  MIN_SERVICE_DURATION_MINUTES,
  MAX_SERVICE_DURATION_MINUTES,
  normalizeSpecies,
  describeSpecies,
  isServiceAvailableForSpecies,
  getServiceUnavailableReason,
  isServiceBookable,
  mapServiceForClient,
  listServicesForClient,
  findServiceByIdOrName,
  countServicesForAnalytics,
  isCheckupService
};
