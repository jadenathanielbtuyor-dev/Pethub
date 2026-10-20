// THE CLINIC'S SERVICES: the only source of the service list. Bookings are checked against it
// (validators/appointmentsValidator.js, services/appointmentsService.js), the booking page loads it from
// GET /appointments/services, the admin charts group by it, and the public Services page and the chatbot repeat it
// (tests/services.test.js keeps them in step). No prices: none have been confirmed.
//
// DURATIONS — NOT CONFIRMED YET. The scheduler blocks overlapping approved appointments using each service's length,
// so a service can only be booked online once its length is known. Fill in ONLY minutes the clinic has confirmed:
//   - one value per service in durationMinutes below, or
//   - if the clinic uses one standard length for every service, STANDARD_DURATION_MINUTES (a service's own value,
//     when set, wins).
// Until then GET /appointments/services marks every service "not bookable yet" and POST /appointments/create refuses
// them; existing appointments keep the duration saved with them.
//
// SPECIES — the clinic serves dogs and cats only (SERVICE_SPECIES). Each service lists the species it may be booked for.
// PENDING CLINIC CONFIRMATION: the proposed rule "Puppy Cut is for dogs only" is NOT applied; every service lists both
// species until the clinic confirms otherwise (change that service's species to ['Dog'] to apply it).
//
// Descriptions only say what each service's name means (no prices, durations, results or medical claims); the clinic
// should review the wording.

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
  service('Puppy Cut', 'grooming', 'A short, even haircut all over the coat.'),
  service('Full Grooming', 'grooming', 'A full grooming session for your dog or cat.'),
  service('Nail Cutting', 'grooming', 'Trimming of your pet’s nails.'),
  service('Face Trim', 'grooming', 'A trim of the fur around your pet’s face.'),
  service('Flea and Tick Removal', 'grooming', 'Removal of fleas and ticks from your pet’s coat.'),
  service('Medicated Bath', 'grooming', 'A bath using a medicated product.'),
  service('Dog & Cat Full Check Up', 'veterinary', 'A full veterinary check-up for your dog or cat.')
]);

// Services whose species rule still needs the clinic's confirmation (see SPECIES above). The public Services page marks
// them with a development placeholder; remove a name once the clinic has confirmed its species.
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
