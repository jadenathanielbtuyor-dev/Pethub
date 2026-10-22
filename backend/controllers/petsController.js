const petsService = require('../services/petsService');
const { createControllerHandler } = require('../utils/controllerFactory');

const createPet = createControllerHandler(petsService.createPet, 'createPet');
const updatePet = createControllerHandler(petsService.updatePet, 'updatePet');
const getUserPets = createControllerHandler(petsService.getUserPets, 'getUserPets');
const getPetHistory = createControllerHandler(petsService.getPetHistory, 'getPetHistory');
const deletePet = createControllerHandler(petsService.deletePet, 'deletePet');
const getUserMedicalRecords = createControllerHandler(petsService.getUserMedicalRecords, 'getUserMedicalRecords');
const createMedicalRecord = createControllerHandler(petsService.createMedicalRecord, 'createMedicalRecord');
const createOwnerWeightReport = createControllerHandler(petsService.createOwnerWeightReport, 'createOwnerWeightReport');

module.exports = {
  createPet,
  updatePet,
  getUserPets,
  getPetHistory,
  deletePet,
  getUserMedicalRecords,
  createMedicalRecord,
  createOwnerWeightReport
};
