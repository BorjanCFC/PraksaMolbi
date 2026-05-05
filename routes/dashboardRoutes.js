const express = require('express');
const router = express.Router();
const molbiController = require('../controllers/molbiController');
const { studentPdfUpload } = require('../middlewares/upload');

router.get('/dashboard', molbiController.getDashboard);
router.post('/dashboard/assign-role', molbiController.assignRoleByEmail);
router.get('/dashboard/nova-molba', molbiController.getNovaMolba);
router.post('/dashboard/nova-molba', studentPdfUpload.single('document'), molbiController.postNovaMolba);
router.get('/dashboard/molba/:id', molbiController.getMolbaDetail);
router.post('/dashboard/molba/:id/status', molbiController.updateStatus);
router.post('/dashboard/molba/:id/archive-number', molbiController.updateArchiveNumber);
router.post('/dashboard/molba/:id/generate-archive-pdf', molbiController.generateArchivePdf);
router.post('/dashboard/molba/:id/generate-molba-pdf', molbiController.generateMolbaPdf);
router.get('/dashboard/molba/:id/document/student', molbiController.downloadStudentDocument);
router.get('/dashboard/molba/:id/document/archive', molbiController.downloadArchivePdf);

module.exports = router;
