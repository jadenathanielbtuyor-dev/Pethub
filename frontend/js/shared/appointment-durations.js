// The clinic's services for the booking page, as the server lists them (GET /appointments/services; the list itself
// is backend/constants/services.js). Nothing is hard-coded here: until setCatalog() is called the page knows no
// services, and a service's duration is only what the server says (null while the clinic has not confirmed it).
// The file name is older than the catalog; the global stays AppointmentDurations so existing pages keep working.
(function initAppointmentDurations(root) {
  let services = [];

  function normalizeServiceName(serviceType) {
    return String(serviceType || '').trim();
  }

  function setCatalog(list) {
    services = (Array.isArray(list) ? list : [])
      .filter(service => service && typeof service.name === 'string' && service.name.trim())
      .map(service => Object.freeze({
        name: service.name.trim(),
        category: String(service.category || ''),
        categoryLabel: String(service.category_label || service.category || ''),
        description: String(service.description || ''),
        species: Object.freeze(Array.isArray(service.species) ? service.species.map(String) : []),
        durationMinutes: Number.isInteger(service.duration_minutes) && service.duration_minutes > 0 ? service.duration_minutes : null
      }));
  }

  function getServices() {
    return services.slice();
  }

  function getService(serviceType) {
    const name = normalizeServiceName(serviceType);
    return services.find(service => service.name === name) || null;
  }

  function hasService(serviceType) {
    return getService(serviceType) !== null;
  }

  function getDurationMinutes(serviceType) {
    const service = getService(serviceType);
    return service ? service.durationMinutes : null;
  }

  // A service can be booked online once the clinic has confirmed its duration
  function isBookable(serviceType) {
    return getDurationMinutes(serviceType) !== null;
  }

  function isAvailableForSpecies(serviceType, species) {
    const service = getService(serviceType);
    const wanted = String(species || '').trim().toLowerCase();
    return Boolean(service && wanted && service.species.some(entry => entry.toLowerCase() === wanted));
  }

  function formatDuration(serviceType) {
    const minutes = getDurationMinutes(serviceType);
    if (!Number.isFinite(minutes)) return 'Not confirmed yet';

    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      return `${hours} hour${hours === 1 ? '' : 's'}`;
    }
    return `${minutes} minutes`;
  }

  const api = Object.freeze({
    setCatalog,
    getServices,
    getService,
    hasService,
    getDurationMinutes,
    isBookable,
    isAvailableForSpecies,
    formatDuration
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  root.AppointmentDurations = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
