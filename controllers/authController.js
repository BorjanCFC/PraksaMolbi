const bcrypt = require('bcryptjs');
const { Student, Admin } = require('../models');

// GET /login - prikazi login stranica
exports.getLogin = (req, res) => {
  // Ako e veke najavен, preusmeri
  if (req.session && req.session.isAdmin) return res.redirect('/admin/dashboard');
  if (req.session && req.session.studentId) return res.redirect('/dashboard');

  res.render('login', {
    title: 'Најава',
    error: req.flash('error'),
    success: req.flash('success')
  });
};

// POST /login - procesiranje na login (proveruva i Student i Admin)
exports.postLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Prvo proveri dali e Admin
    const admin = await Admin.findOne({ where: { email } });
    if (admin) {
      const isMatch = await bcrypt.compare(password, admin.password);
      if (isMatch) {
        req.session.adminId = admin.adminId;
        req.session.adminName = `${admin.ime} ${admin.prezime}`;
        req.session.isAdmin = true;
        return res.redirect('/admin/dashboard');
      }
    }

    // Potoa proveri dali e Student
    const student = await Student.findOne({ where: { email } });
    if (student) {
      const isMatch = await bcrypt.compare(password, student.password);
      if (isMatch) {
        req.session.studentId = student.studentId;
        req.session.studentName = `${student.ime} ${student.prezime}`;
        req.session.brIndeks = student.brIndeks;
        return res.redirect('/dashboard');
      }
    }

    // Ako nitu eden ne odgovara
    req.flash('error', 'Невалиден email или лозинка.');
    res.redirect('/login');
  } catch (error) {
    console.error('Login error:', error);
    req.flash('error', 'Настана грешка при најава.');
    res.redirect('/login');
  }
};

// GET /logout - odjava (za site)
exports.logout = (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('Logout error:', err);
    res.redirect('/login');
  });
};
