const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const { isAuthenticated } = require('../middlewares/authMiddleware');

// Site dashboard ruti se zashtiteni so auth middleware
router.get('/dashboard', isAuthenticated, dashboardController.getDashboard);
router.get('/dashboard/nova-molba', isAuthenticated, dashboardController.getnovaMolba);
router.post('/dashboard/nova-molba', isAuthenticated, dashboardController.postNovaMolba);
router.get('/dashboard/molba/:id', isAuthenticated, dashboardController.getMolbaDetail);

module.exports = router;
