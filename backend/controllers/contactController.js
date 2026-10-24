const contactService = require('../services/contactService');
const clinicSettingsService = require('../services/clinicSettingsService');
const { createControllerHandler } = require('../utils/controllerFactory');

const submitContactRequest = createControllerHandler(contactService.submitContactRequest, 'submitContactRequest');
const listMyMessages = createControllerHandler(contactService.listMyMessages, 'listMyMessages');
const getClinicInfo = createControllerHandler(clinicSettingsService.getPublicClinicInfo, 'getClinicInfo');

module.exports = {
  submitContactRequest,
  listMyMessages,
  getClinicInfo
};
