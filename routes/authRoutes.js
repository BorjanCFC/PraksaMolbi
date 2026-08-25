const express = require('express');
const router = express.Router();

const authController =
  require('../controllers/authController');

router.get(
  '/login',
  authController.getLogin
);

router.post(
  '/login',
  authController.postLogin
);

router.get(
  '/admin-login',
  authController.getAdminLogin
);

router.post(
  '/admin-login',
  authController.postAdminLogin
);

router.get(
  '/auth/microsoft',
  authController.startMicrosoftLogin
);

router.get(
  '/auth/microsoft/callback',
  authController.microsoftCallback
);


// Multi-role selection
router.get(
  '/select-role',
  authController.getSelectRole
);

router.post(
  '/select-role',
  authController.postSelectRole
);


router.get(
  '/logout',
  authController.logout
);


router.get('/', (req, res) => {
  res.redirect('/login');
});


module.exports = router;