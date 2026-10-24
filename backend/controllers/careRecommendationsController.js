const careRecommendationService = require('../services/careRecommendationService');
const { createControllerHandler } = require('../utils/controllerFactory');

module.exports = {
  listOwnerRecommendations: createControllerHandler(careRecommendationService.listOwnerRecommendations, 'listOwnerRecommendations', 'pets'),
  acknowledgeRecommendation: createControllerHandler(careRecommendationService.acknowledgeRecommendation, 'acknowledgeRecommendation', 'pets'),
  dismissRecommendation: createControllerHandler(careRecommendationService.dismissRecommendation, 'dismissRecommendation', 'pets'),
  listRules: createControllerHandler(careRecommendationService.listRules, 'listCareRules', 'admin'),
  createRule: createControllerHandler(careRecommendationService.createRule, 'createCareRule', 'admin'),
  updateRule: createControllerHandler(careRecommendationService.updateRule, 'updateCareRule', 'admin'),
  listPetRecommendationsForAdmin: createControllerHandler(careRecommendationService.listPetRecommendationsForAdmin, 'listPetCareRecommendations', 'admin'),
  overrideRecommendation: createControllerHandler(careRecommendationService.overrideRecommendation, 'overrideCareRecommendation', 'admin'),
  generateForAppointment: createControllerHandler(careRecommendationService.generateForAppointment, 'generateCareRecommendation', 'admin')
};
