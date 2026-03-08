const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');

// Middleware za proverka dali admin e najavен
const isAdminAuthenticated = (req, res, next) => {
  if (req.session && req.session.adminId && req.session.isAdmin) {
    return next();
  }
  req.flash('error', 'Ве молиме најавете се како администратор.');
  res.redirect('/login');
};

router.get('/admin/dashboard', isAdminAuthenticated, adminController.getDashboard);
router.get('/admin/molba/:id', isAdminAuthenticated, adminController.getMolbaDetail);
router.post('/admin/molba/:id/status', isAdminAuthenticated, adminController.updateStatus);

module.exports = router;
