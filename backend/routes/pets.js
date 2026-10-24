const express = require('express');
const router = express.Router();
const {
  createPet,
  updatePet,
  getUserPets,
  getPetHistory,
  deletePet,
  getUserMedicalRecords,
  createMedicalRecord,
  createOwnerWeightReport
} = require('../controllers/petsController');
const { requireAuth } = require('../middleware/requireAuth');
const breedCatalogController = require('../controllers/breedCatalogController');
const careRecommendationsController = require('../controllers/careRecommendationsController');

router.use(requireAuth);

router.post('/create', createPet);
router.get('/userPets', getUserPets);
router.get('/breeds', breedCatalogController.listOwnerBreeds);
router.put('/update/:id', updatePet);
router.get('/history/:id', getPetHistory);
router.post('/:id/weight-reports', createOwnerWeightReport);
router.get('/medical-records', getUserMedicalRecords);
// The signed-in owner's next-care suggestions; acknowledging or dismissing never books anything
router.get('/care-recommendations', careRecommendationsController.listOwnerRecommendations);
router.post('/care-recommendations/:id/acknowledge', careRecommendationsController.acknowledgeRecommendation);
router.post('/care-recommendations/:id/dismiss', careRecommendationsController.dismissRecommendation);
router.post('/medical-records/create', createMedicalRecord);
router.delete('/delete/:id', deletePet);

module.exports = router;
