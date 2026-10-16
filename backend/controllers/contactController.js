const contactService = require('../services/contactService');
const { createControllerHandler } = require('../utils/controllerFactory');

const submitContactRequest = createControllerHandler(contactService.submitContactRequest, 'submitContactRequest');

module.exports = {
  submitContactRequest
};
