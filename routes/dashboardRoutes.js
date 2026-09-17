const express = require('express');
const router = express.Router();
const molbiController = require('../controllers/molbiController');
const { studentPdfUpload } = require('../middlewares/upload');
// Verify staff role membership against DB to revoke removed permissions immediately.
const { Role, UserRole } = require('../models');
const staffTipByRole = {
  admin: 'Admin',
  studentska_sluzhba: 'Sluzhba',
  prodekan: 'Prodekan',
  arhiva: 'Arhiva'
};
router.use('/dashboard', async (req, res, next) => {
  const user = req.session && req.session.user;
  if (!user || !user.role || user.role === 'student') return next();
  const tip = staffTipByRole[user.role];
  if (!tip) return res.status(403).send('Непозната административна улога.');
  try {
    const role = await Role.findOne({ where: { tip } });
    const assignment = role && await UserRole.findOne({
      where: { userId: user.userId, roleId: role.roleId }
    });
    if (assignment) return next();
    return req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('connect.sid');
      return res.redirect('/admin-login');
    });
  } catch (error) {
    return next(error);
  }
});


router.get('/dashboard', molbiController.getDashboard);
router.post('/dashboard/assign-role', molbiController.assignRoleByEmail);
router.post('/dashboard/users/:id/remove-role', molbiController.removeRoleFromUser);
router.get('/dashboard/nova-molba', molbiController.getNovaMolba);
router.post('/dashboard/nova-molba', studentPdfUpload.single('document'), molbiController.postNovaMolba);
router.get('/dashboard/molba/:id', molbiController.getMolbaDetail);
router.post('/dashboard/molba/:id/service-review', molbiController.confirmServiceReview);

router.post('/dashboard/molba/:id/status', molbiController.updateStatus);
router.post('/dashboard/molba/:id/archive-number', molbiController.updateArchiveNumber);
router.post('/dashboard/molba/:id/generate-archive-pdf', molbiController.generateArchivePdf);
router.post('/dashboard/molba/:id/generate-molba-pdf', molbiController.generateMolbaPdf);
router.get('/dashboard/molba/:id/document/student', molbiController.downloadStudentDocument);
router.get('/dashboard/molba/:id/document/archive', molbiController.downloadArchivePdf);

module.exports = router;
