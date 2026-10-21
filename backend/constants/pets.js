// Pet profile rules for POST /pets/create and PUT /pets/update/:id (validators/petsValidator.js). The My Pets page
// uses the same values (frontend/pages/user/pets.html, frontend/js/core/utils.js validateAge); tests/pet-profiles.test.js
// keeps them in step.
//
// AGE: the application's configured age-entry range, in whole years. It is a data-entry rule for PetHub, not a
// statement about how long dogs or cats live. Saved profiles keep whatever age they already have until the owner
// changes the age or the species.
const PET_AGE_MIN_YEARS = 1;
const PET_AGE_MAX_YEARS = 25;
const PET_AGE_RANGE_MESSAGE = `Age must be a whole number of years from ${PET_AGE_MIN_YEARS} to ${PET_AGE_MAX_YEARS}.`;

const PET_NAME_MAX_LENGTH = 50;
const PET_BREED_MAX_LENGTH = 50;

// Official medical records store weight as a number; the clinic's form records it in kilograms
// (frontend/js/admin/dashboard.js, "Weight (kg)")
const RECORDED_WEIGHT_UNIT = 'kg';

// 409 answers the My Pets page reacts to
const POSSIBLE_DUPLICATE_PET_CODE = 'POSSIBLE_DUPLICATE_PET';
const POSSIBLE_DUPLICATE_PET_MESSAGE = 'You already have a pet profile with these details. Open that profile, or confirm this is a different pet.';
const PET_HAS_HISTORY_CODE = 'PET_HAS_HISTORY';

module.exports = {
  PET_AGE_MIN_YEARS,
  PET_AGE_MAX_YEARS,
  PET_AGE_RANGE_MESSAGE,
  PET_NAME_MAX_LENGTH,
  PET_BREED_MAX_LENGTH,
  RECORDED_WEIGHT_UNIT,
  POSSIBLE_DUPLICATE_PET_CODE,
  POSSIBLE_DUPLICATE_PET_MESSAGE,
  PET_HAS_HISTORY_CODE
};
