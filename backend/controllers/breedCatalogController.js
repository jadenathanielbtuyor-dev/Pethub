const breedCatalogService = require('../services/breedCatalogService');
const { createControllerHandler } = require('../utils/controllerFactory');

module.exports = {
  listOwnerBreeds: createControllerHandler(breedCatalogService.listOwnerBreeds, 'listOwnerBreeds', 'pets'),
  getBreedCatalog: createControllerHandler(breedCatalogService.getBreedCatalog, 'getBreedCatalog', 'admin'),
  createBreed: createControllerHandler(breedCatalogService.createBreed, 'createBreed', 'admin'),
  updateBreed: createControllerHandler(breedCatalogService.updateBreed, 'updateBreed', 'admin')
};
