// Shared appointment service duration rules.
// Keys intentionally match the Service Type dropdown values exactly.
(function initAppointmentDurations(root) {
  const SERVICE_DURATIONS_MINUTES = Object.freeze({
    Checkup: 45,
    Vaccination: 30,
    Grooming: 240,
    'Dental Cleaning': 60,
    Surgery: 180,
    Other: 30
  });

  function normalizeServiceName(serviceType) {
    return String(serviceType || '').trim();
  }

  function hasService(serviceType) {
    return Object.prototype.hasOwnProperty.call(SERVICE_DURATIONS_MINUTES, normalizeServiceName(serviceType));
  }

  function getDurationMinutes(serviceType) {
    const serviceName = normalizeServiceName(serviceType);
    return hasService(serviceName) ? SERVICE_DURATIONS_MINUTES[serviceName] : null;
  }

  function formatDuration(serviceType) {
    const minutes = getDurationMinutes(serviceType);
    if (!Number.isFinite(minutes)) return 'Duration unavailable';

    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      return `${hours} hour${hours === 1 ? '' : 's'}`;
    }
    return `${minutes} minutes`;
  }

  const api = Object.freeze({
    SERVICE_DURATIONS_MINUTES,
    hasService,
    getDurationMinutes,
    formatDuration
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  root.AppointmentDurations = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
