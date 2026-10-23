const serviceCatalogService = require('../services/serviceCatalogService');
const { createControllerHandler } = require('../utils/controllerFactory');

const listServices = createControllerHandler(serviceCatalogService.listServices, 'listServices', 'appointments');
const listAdminServices = createControllerHandler(serviceCatalogService.listAdminServices, 'listAdminServices', 'admin');
const updateService = createControllerHandler(serviceCatalogService.updateService, 'updateService', 'admin');

module.exports = {
  listServices,
  listAdminServices,
  updateService
};
