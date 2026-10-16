const petsService = require('../services/petsService');
const { createControllerHandler } = require('../utils/controllerFactory');

const createPet = createControllerHandler(petsService.createPet, 'createPet');
const getUserPets = createControllerHandler(petsService.getUserPets, 'getUserPets');
const deletePet = createControllerHandler(petsService.deletePet, 'deletePet');
const getUserMedicalRecords = createControllerHandler(petsService.getUserMedicalRecords, 'getUserMedicalRecords');
const createMedicalRecord = createControllerHandler(petsService.createMedicalRecord, 'createMedicalRecord');

module.exports = {
  createPet,
  getUserPets,
  deletePet,
  getUserMedicalRecords,
  createMedicalRecord
};
