const serviceCatalogService = require('../services/serviceCatalogService');
const { createControllerHandler } = require('../utils/controllerFactory');

const listServices = createControllerHandler(serviceCatalogService.listServices, 'listServices', 'appointments');
const listAdminServices = createControllerHandler(serviceCatalogService.listAdminServices, 'listAdminServices', 'admin');
const createService = createControllerHandler(serviceCatalogService.createService, 'createService', 'admin');
const updateService = createControllerHandler(serviceCatalogService.updateService, 'updateService', 'admin');
const listServiceActivity = createControllerHandler(serviceCatalogService.listServiceActivity, 'listServiceActivity', 'admin');

module.exports = {
  listServices,
  listAdminServices,
  createService,
  updateService,
  listServiceActivity
};
