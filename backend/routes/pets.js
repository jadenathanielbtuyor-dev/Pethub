const express = require('express');
const router = express.Router();
const {
  createPet,
  updatePet,
  getUserPets,
  getPetHistory,
  deletePet,
  getUserMedicalRecords,
  createMedicalRecord
} = require('../controllers/petsController');
const { requireAuth } = require('../middleware/requireAuth');

router.use(requireAuth);

router.post('/create', createPet);
router.get('/userPets', getUserPets);
router.put('/update/:id', updatePet);
router.get('/history/:id', getPetHistory);
router.get('/medical-records', getUserMedicalRecords);
router.post('/medical-records/create', createMedicalRecord);
router.delete('/delete/:id', deletePet);

module.exports = router;
