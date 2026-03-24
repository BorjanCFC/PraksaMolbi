const { Molba, Student } = require('../models');

const ADMIN_NAME = 'Администратор Студентска Служба';

const isAdminSession = (req) => req.session && req.session.isAdmin === true;
const isStudentSession = (req) => req.session && !!req.session.studentId && !req.session.isAdmin;

const requireStudent = (req, res) => {
  if (isStudentSession(req)) return true;
  req.flash('error', 'Ве молиме најавете се.');
  res.redirect('/login');
  return false;
};

const requireAdmin = (req, res) => {
  if (isAdminSession(req)) return true;
  req.flash('error', 'Ве молиме најавете се како администратор.');
  res.redirect('/login');
  return false;
};

// GET /dashboard
exports.getStudentDashboard = async (req, res) => {
  if (isAdminSession(req)) {
    return exports.getAdminDashboard(req, res);
  }

  if (!requireStudent(req, res)) return;

  try {
    const student = await Student.findByPk(req.session.studentId);
    const { status } = req.query;

    const whereClause = { studentId: req.session.studentId };
    if (status && status !== 'site') {
      whereClause.status = status;
    }

    const molbi = await Molba.findAll({
      where: whereClause,
      order: [['datum', 'DESC']]
    });

    const siteMolbi = await Molba.findAll({
      where: { studentId: req.session.studentId }
    });

    res.render('dashboard', {
      title: 'Dashboard',
      isAdmin: false,
      student,
      molbi,
      siteMolbi,
      currentStatus: status || 'site',
      success: req.flash('success'),
      error: req.flash('error')
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    req.flash('error', 'Настана грешка при вчитување.');
    res.redirect('/login');
  }
};

// GET /dashboard/nova-molba
exports.getNovaMolba = (req, res) => {
  if (!requireStudent(req, res)) return;

  res.render('nova-molba', {
    title: 'Нова молба',
    studentName: req.session.studentName,
    error: req.flash('error')
  });
};

// POST /dashboard/nova-molba
exports.postNovaMolba = async (req, res) => {
  if (!requireStudent(req, res)) return;

  try {
    const { naslov, description } = req.body;

    if (!naslov || naslov.trim() === '') {
      req.flash('error', 'Насловот е задолжителен.');
      return res.redirect('/dashboard/nova-molba');
    }

    if (!description || description.trim() === '') {
      req.flash('error', 'Описот е задолжителен.');
      return res.redirect('/dashboard/nova-molba');
    }

    await Molba.create({
      studentId: req.session.studentId,
      naslov: naslov.trim(),
      description: description.trim(),
      status: 'Во процес',
      datum: new Date()
    });

    req.flash('success', 'Молбата е успешно испратена!');
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Create molba error:', error);
    req.flash('error', 'Настана грешка при креирање на молбата.');
    res.redirect('/dashboard/nova-molba');
  }
};

// GET /dashboard/molba/:id
exports.getStudentMolbaDetail = async (req, res) => {
  if (!requireStudent(req, res)) return;

  try {
    const molba = await Molba.findOne({
      where: {
        molbaId: req.params.id,
        studentId: req.session.studentId
      }
    });

    if (!molba) {
      req.flash('error', 'Молбата не е пронајдена.');
      return res.redirect('/dashboard');
    }

    res.render('molba-detail', {
      title: `Молба #${molba.molbaId}`,
      isAdmin: false,
      molba,
      studentName: req.session.studentName,
      success: req.flash('success'),
      error: req.flash('error')
    });
  } catch (error) {
    console.error('Molba detail error:', error);
    req.flash('error', 'Настана грешка.');
    res.redirect('/dashboard');
  }
};

// GET /admin/dashboard
exports.getAdminDashboard = async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const { status, studentId } = req.query;

    const whereClause = {};
    if (status && status !== 'site') {
      whereClause.status = status;
    }

    if (studentId && studentId !== 'site') {
      const parsedStudentId = Number.parseInt(studentId, 10);
      if (!Number.isNaN(parsedStudentId)) {
        whereClause.studentId = parsedStudentId;
      }
    }

    const molbi = await Molba.findAll({
      where: whereClause,
      include: [{ model: Student, as: 'student' }],
      order: [['datum', 'DESC']]
    });

    const siteMolbi = await Molba.findAll({
      include: [{ model: Student, as: 'student' }]
    });

    const studenti = await Student.findAll({
      order: [['ime', 'ASC']]
    });

    const stats = {
      vkupno: siteMolbi.length,
      voProces: siteMolbi.filter((m) => m.status === 'Во процес').length,
      odobreni: siteMolbi.filter((m) => m.status === 'Одобрена').length,
      odbieni: siteMolbi.filter((m) => m.status === 'Одбиена').length
    };

    res.render('dashboard', {
      title: 'Студентска Служба - Dashboard',
      isAdmin: true,
      adminName: req.session.adminName || ADMIN_NAME,
      molbi,
      stats,
      studenti,
      currentStatus: status || 'site',
      currentStudentId: studentId || 'site',
      success: req.flash('success'),
      error: req.flash('error')
    });
  } catch (error) {
    console.error('Admin dashboard error:', error);
    req.flash('error', 'Настана грешка.');
    res.redirect('/dashboard');
  }
};

// GET /admin/molba/:id
exports.getAdminMolbaDetail = async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const molba = await Molba.findByPk(req.params.id, {
      include: [{ model: Student, as: 'student' }]
    });

    if (!molba) {
      req.flash('error', 'Молбата не е пронајдена.');
      return res.redirect('/dashboard');
    }

    res.render('molba-detail', {
      title: `Молба #${molba.molbaId}`,
      isAdmin: true,
      adminName: req.session.adminName || ADMIN_NAME,
      molba,
      success: req.flash('success'),
      error: req.flash('error')
    });
  } catch (error) {
    console.error('Admin molba detail error:', error);
    req.flash('error', 'Настана грешка.');
    res.redirect('/dashboard');
  }
};

// POST /admin/molba/:id/status
exports.updateAdminStatus = async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const { status, feedback } = req.body;
    const allowedStatuses = new Set(['Во процес', 'Одобрена', 'Одбиена']);

    if (!allowedStatuses.has(status)) {
      req.flash('error', 'Невалиден статус.');
      return res.redirect('/dashboard');
    }

    const molba = await Molba.findByPk(req.params.id);
    if (!molba) {
      req.flash('error', 'Молбата не е пронајдена.');
      return res.redirect('/dashboard');
    }

    molba.status = status;
    molba.feedback = feedback && feedback.trim() !== '' ? feedback.trim() : null;
    await molba.save();

    req.flash('success', `Статусот на молбата е ажуриран.`);
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Update status error:', error);
    req.flash('error', 'Настана грешка при ажурирање.');
    res.redirect('/dashboard');
  }
};