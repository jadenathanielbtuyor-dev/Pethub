// Pet care recommendations (database/migrations/2026-10-24_multi_pet_booking_and_care_recommendations.sql).
// The clinic configures the rules; PetHub ships with none. Suggestions are general care reminders, never a diagnosis.

const GUIDANCE_TYPES = Object.freeze({ general: 'general', veterinarianApproved: 'veterinarian_approved' });
const GUIDANCE_LABELS = Object.freeze({
  general: 'General care guidance',
  veterinarian_approved: 'Recommended by the clinic veterinarian'
});

// How a suggestion was made: from a clinic rule, set by clinic staff, or no rule yet (the clinic should advise)
const RECOMMENDATION_BASIS = Object.freeze({ rule: 'rule', clinicSet: 'clinic_set', needsReview: 'needs_review' });
const RECOMMENDATION_STATUSES = Object.freeze({
  active: 'active',
  acknowledged: 'acknowledged',
  dismissed: 'dismissed',
  superseded: 'superseded'
});
// What the owner sees (dismissed and superseded suggestions are no longer shown)
const OWNER_VISIBLE_STATUSES = Object.freeze(['active', 'acknowledged']);

const RULE_INTERVAL_LIMITS = Object.freeze({ minDays: 1, maxDays: 1825 });
const RULE_DESCRIPTION_MAX = 300;
const RULE_EXPLANATION_MAX = 600;
const OVERRIDE_NOTE_MAX = 300;

const CARE_DISCLAIMER = 'This is a general care reminder, not a diagnosis or prescription. Ask the clinic if your pet has health concerns.';

// PetHub's starting guidance, shown to clinic staff as reference when they create a rule. It is NOT applied
// automatically: nothing is suggested to owners until the clinic saves a rule for a service.
const STARTING_GUIDANCE = Object.freeze([
  Object.freeze({ topic: 'General checkup', guidance: 'At least annually for many healthy adult dogs; more frequent examinations may suit age, species, breed, lifestyle and health.' }),
  Object.freeze({ topic: 'Vaccination', guidance: "Based on the pet's vaccination history, vaccine type, age, risk and a veterinarian-approved schedule." }),
  Object.freeze({ topic: 'Grooming / face trim', guidance: 'Coat-dependent. About 6–8 weeks may suit many continuously growing or high-maintenance coats; other pets need less frequent grooming. Not universal.' }),
  Object.freeze({ topic: 'Dental cleaning', guidance: 'Based on a dental examination and veterinarian recommendation (AAHA: many pets every 1–2 years, some more often).' }),
  Object.freeze({ topic: 'Surgery', guidance: "No automatic recurring interval; follow-ups follow the veterinarian's instructions." }),
  Object.freeze({ topic: 'Other services', guidance: 'No automatic interval unless the clinic defines one.' })
]);

module.exports = {
  GUIDANCE_TYPES,
  GUIDANCE_LABELS,
  RECOMMENDATION_BASIS,
  RECOMMENDATION_STATUSES,
  OWNER_VISIBLE_STATUSES,
  RULE_INTERVAL_LIMITS,
  RULE_DESCRIPTION_MAX,
  RULE_EXPLANATION_MAX,
  OVERRIDE_NOTE_MAX,
  CARE_DISCLAIMER,
  STARTING_GUIDANCE
};
