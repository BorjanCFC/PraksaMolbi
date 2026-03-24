const bcrypt = require('bcryptjs');
const { Student } = require('../models');

const ADMIN_EMAIL = 'admin@university.mk';
const ADMIN_PASSWORD = 'password123';
const ADMIN_NAME = 'Администратор Студентска Служба';

const isAdminSession = (req) => req.session && req.session.isAdmin === true;
const isStudentSession = (req) => req.session && !!req.session.studentId && !req.session.isAdmin;

// GET /login and /admin/login
exports.getLogin = (req, res) => {
  if (isAdminSession(req)) return res.redirect('/dashboard');
  if (isStudentSession(req)) return res.redirect('/dashboard');

  res.render('login', {
    title: 'Најава',
    error: req.flash('error'),
    success: req.flash('success')
  });
};

// POST /login and /admin/login
exports.postLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
      req.session.adminId = 'static-admin';
      req.session.adminName = ADMIN_NAME;
      req.session.isAdmin = true;

      delete req.session.studentId;
      delete req.session.studentName;
      delete req.session.brIndeks;

      return res.redirect('/dashboard');
    }

    const student = await Student.findOne({ where: { email } });
    if (student) {
      const isMatch = await bcrypt.compare(password, student.password);
      if (isMatch) {
        req.session.studentId = student.studentId;
        req.session.studentName = `${student.ime} ${student.prezime}`;
        req.session.brIndeks = student.brIndeks;
        req.session.isAdmin = false;

        delete req.session.adminId;
        delete req.session.adminName;

        return res.redirect('/dashboard');
      }
    }

    req.flash('error', 'Невалиден email или лозинка.');
    return res.redirect('/login');
  } catch (error) {
    console.error('Login error:', error);
    req.flash('error', 'Настана грешка при најава.');
    return res.redirect('/login');
  }
};

// GET /logout and /admin/logout
exports.logout = (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('Logout error:', err);
    res.redirect('/login');
  });
};
