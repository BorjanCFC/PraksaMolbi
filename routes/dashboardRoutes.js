const express = require('express');
const router = express.Router();
const molbiController = require('../controllers/molbiController');

router.get('/dashboard', molbiController.getStudentDashboard);
router.get('/dashboard/nova-molba', molbiController.getNovaMolba);
router.post('/dashboard/nova-molba', molbiController.postNovaMolba);
router.get('/dashboard/molba/:id', molbiController.getStudentMolbaDetail);

router.get('/admin/dashboard', molbiController.getAdminDashboard);
router.get('/admin/molba/:id', molbiController.getAdminMolbaDetail);
router.post('/admin/molba/:id/status', molbiController.updateAdminStatus);

module.exports = router;
