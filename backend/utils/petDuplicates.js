// Likely duplicate pet profiles within ONE owner's account (POST /pets/create, PUT /pets/update/:id).
//
// pets has no stable identifier for an animal (no microchip number), so this can only point out profiles that look
// the same; it never merges or blocks them. A profile is a likely duplicate when it has
//   - the same name (ignoring letter case and extra spaces), AND
//   - the same species, AND
//   - a breed that does not contradict (equal, or blank on either side), AND
//   - an age that does not contradict: within 1 year of the saved age, or of the saved age plus the whole years since
//     that profile was added (the saved age does not grow by itself), or blank on either side.
// A matching name alone is never enough: two pets of one household may share a name. The owner sees the match and
// either opens that profile or confirms a different pet (confirm_not_duplicate). Only the owner's own pets are
// compared, so nothing about other accounts is ever revealed.
const { normalizeSpecies } = require('./serviceCatalog');

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

function normalizeText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function sameSpecies(first, second) {
  return (normalizeSpecies(first) || normalizeText(first)) === (normalizeSpecies(second) || normalizeText(second));
}

function breedsAgree(first, second) {
  const a = normalizeText(first);
  const b = normalizeText(second);
  return !a || !b || a === b;
}

function getWholeYearsSince(value, now) {
  const time = new Date(value || '').getTime();
  if (!Number.isFinite(time) || time > now.getTime()) return 0;
  return Math.floor((now.getTime() - time) / YEAR_MS);
}

function agesAgree(candidateAge, pet, now) {
  const age = Number(candidateAge);
  const savedAge = Number(pet.age);
  if (candidateAge === null || candidateAge === undefined || !Number.isFinite(age)) return true;
  if (pet.age === null || pet.age === undefined || !Number.isFinite(savedAge)) return true;
  const ageNow = savedAge + getWholeYearsSince(pet.created_at, now);
  return Math.abs(age - savedAge) <= 1 || Math.abs(age - ageNow) <= 1;
}

/**
 * The owner's profiles that look like candidate ({ name, species, breed, age }), excluding excludePetId (the profile
 * being edited).
 */
function findLikelyDuplicatePets(candidate, ownerPets, { excludePetId = '', now = new Date() } = {}) {
  const name = normalizeText(candidate?.name);
  if (!name) return [];

  return (Array.isArray(ownerPets) ? ownerPets : []).filter(pet => (
    pet &&
    String(pet.id) !== String(excludePetId) &&
    normalizeText(pet.name) === name &&
    sameSpecies(pet.species, candidate.species) &&
    breedsAgree(pet.breed, candidate.breed) &&
    agesAgree(candidate.age, pet, now)
  ));
}

// What the owner is shown about a match: their own profile's details, nothing else
function describeDuplicate(pet) {
  return {
    id: pet.id,
    name: pet.name,
    species: pet.species,
    breed: pet.breed ?? null,
    age: pet.age ?? null,
    created_at: pet.created_at ?? null
  };
}

module.exports = {
  normalizeText,
  findLikelyDuplicatePets,
  describeDuplicate
};
