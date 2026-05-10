const express = require('express');
const router = express.Router();
const { createPet, getUserPets, deletePet, getUserMedicalRecords, createMedicalRecord } = require('../controllers/petsController');

router.post('/create', createPet);
router.get('/userPets', getUserPets);
router.get('/medical-records', getUserMedicalRecords);
router.post('/medical-records/create', createMedicalRecord);
router.delete('/delete/:id', deletePet);

module.exports = router;
