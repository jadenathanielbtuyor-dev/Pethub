// Questions about the clinic's services, answered from constants/services.js (the data lives there so it can be
// reviewed and changed in one place).
const {
  SERVICE_SPECIES,
  STANDARD_DURATION_MINUTES,
  SERVICE_CATEGORIES,
  SERVICE_CATALOG,
  CHECKUP_SERVICE_NAMES
} = require('../constants/services');

const EARLIER_SERVICE_SUFFIX = '(earlier service)';
const NOT_RECORDED_LABEL = 'Service not recorded';

function getService(serviceType) {
  const name = String(serviceType || '').trim();
  return SERVICE_CATALOG.find(entry => entry.name === name) || null;
}

function isPositiveMinutes(value) {
  return Number.isInteger(value) && value > 0;
}

// Confirmed minutes for a catalog service, or null while the clinic has not confirmed them
function getServiceDurationMinutes(serviceType) {
  const entry = getService(serviceType);
  if (!entry) return null;
  if (isPositiveMinutes(entry.durationMinutes)) return entry.durationMinutes;
  return isPositiveMinutes(STANDARD_DURATION_MINUTES) ? STANDARD_DURATION_MINUTES : null;
}

function isServiceBookable(serviceType) {
  return getServiceDurationMinutes(serviceType) !== null;
}

// 'Dog' / 'Cat' for any letter case, '' for anything else
function normalizeSpecies(value) {
  const text = String(value || '').trim().toLowerCase();
  return SERVICE_SPECIES.find(species => species.toLowerCase() === text) || '';
}

function isServiceAvailableForSpecies(serviceType, species) {
  const entry = getService(serviceType);
  const normalized = normalizeSpecies(species);
  return Boolean(entry && normalized && entry.species.includes(normalized));
}

// "dogs and cats", "dogs"
function describeSpecies(speciesList) {
  const words = speciesList.map(species => `${species.toLowerCase()}s`);
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0] || '';
}

// What the booking page needs (GET /appointments/services)
function listServicesForClient() {
  return SERVICE_CATALOG.map(entry => ({
    name: entry.name,
    category: entry.category,
    category_label: SERVICE_CATEGORIES[entry.category],
    description: entry.description,
    species: [...entry.species],
    duration_minutes: getServiceDurationMinutes(entry.name),
    bookable: isServiceBookable(entry.name)
  }));
}

// Admin "services" chart: every catalog service (0 when never booked), then each earlier service name that saved
// appointments still carry, labelled as such so historical bookings stay visible
function countServicesForAnalytics(serviceTypes) {
  const counts = new Map(SERVICE_CATALOG.map(entry => [entry.name, 0]));
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

function isCheckupService(serviceType) {
  return CHECKUP_SERVICE_NAMES.includes(String(serviceType || '').trim());
}

module.exports = {
  EARLIER_SERVICE_SUFFIX,
  getService,
  getServiceDurationMinutes,
  isServiceBookable,
  normalizeSpecies,
  isServiceAvailableForSpecies,
  describeSpecies,
  listServicesForClient,
  countServicesForAnalytics,
  isCheckupService
};
