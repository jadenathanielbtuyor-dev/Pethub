// Initial service metadata used by the prepared database migration and isolated test fixtures only.
// Runtime service configuration is stored in pethub_service_catalog. Do not use this list to authorize a booking or
// render the current service list. No prices, durations, hours or capacity have been confirmed.

const SERVICE_SPECIES = Object.freeze(['Dog', 'Cat']);

const STANDARD_DURATION_MINUTES = null;

const SERVICE_CATEGORIES = Object.freeze({
  grooming: 'Grooming',
  veterinary: 'Veterinary check-up'
});

function service(name, category, description, { species = SERVICE_SPECIES, durationMinutes = null } = {}) {
  return Object.freeze({ name, category, description, species: Object.freeze([...species]), durationMinutes });
}

const SERVICE_CATALOG = Object.freeze([
  service('Bath', 'grooming', 'A bath for your dog or cat.'),
  service('Trim', 'grooming', 'A trim of your pet’s coat.'),
  service('Puppy Cut', 'grooming', 'A short, even haircut all over the coat.', { species: [] }),
  service('Full Grooming', 'grooming', 'A full grooming session for your dog or cat.'),
  service('Nail Cutting', 'grooming', 'Trimming of your pet’s nails.'),
  service('Face Trim', 'grooming', 'A trim of the fur around your pet’s face.'),
  service('Flea and Tick Removal', 'grooming', 'Removal of fleas and ticks from your pet’s coat.'),
  service('Medicated Bath', 'grooming', 'A bath using a medicated product.'),
  service('Dog & Cat Full Check Up', 'veterinary', 'A full veterinary check-up for your dog or cat.')
]);

// Services whose species rule still needs the clinic's confirmation.
const SPECIES_PENDING_CONFIRMATION = Object.freeze(['Puppy Cut']);

// Service names saved on appointments booked before this catalog (the live database had two "Checkup" appointments on
// 2026-10-20). They can no longer be booked, but their appointments keep their saved duration and can still be
// approved, completed or cancelled; analytics list them as earlier services.
const LEGACY_SERVICE_NAMES = Object.freeze(['Checkup', 'Vaccination', 'Grooming', 'Dental Cleaning', 'Surgery', 'Other']);

// Appointments counted as check-ups by the admin "Upcoming check-ups" figure: the current check-up service and the
// earlier "Checkup"
const CHECKUP_SERVICE_NAMES = Object.freeze(['Dog & Cat Full Check Up', 'Checkup']);

module.exports = {
  SERVICE_SPECIES,
  STANDARD_DURATION_MINUTES,
  SERVICE_CATEGORIES,
  SERVICE_CATALOG,
  SPECIES_PENDING_CONFIRMATION,
  LEGACY_SERVICE_NAMES,
  CHECKUP_SERVICE_NAMES
};
