// The clinic's public contact details, entered by an admin (System Management > Contact messages) and stored in
// system_settings. PetHub ships with none: the Contact page and the appointment emails show only what the clinic has
// entered, never placeholder values.
const CLINIC_CONTACT_FIELDS = Object.freeze({
  phone: Object.freeze({ key: 'clinic.phone', label: 'Phone number', maxLength: 25 }),
  email: Object.freeze({ key: 'clinic.email', label: 'Email address', maxLength: 254 }),
  address: Object.freeze({ key: 'clinic.address', label: 'Address', maxLength: 200 }),
  hours: Object.freeze({ key: 'clinic.hours', label: 'Opening hours', maxLength: 200 })
});

const CLINIC_CONTACT_KEYS = Object.freeze(Object.values(CLINIC_CONTACT_FIELDS).map(field => field.key));

module.exports = {
  CLINIC_CONTACT_FIELDS,
  CLINIC_CONTACT_KEYS
};
