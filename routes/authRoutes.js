const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

router.get('/login', authController.getLogin);
router.get('/admin-login', authController.getAdminLogin);
router.post('/login', authController.postLogin);
router.get('/auth/microsoft', authController.startMicrosoftLogin);
router.get('/auth/microsoft/callback', authController.microsoftCallback);
router.get('/logout', authController.logout);

router.get('/', (req, res) => {
  res.redirect('/login');
});

module.exports = router;
