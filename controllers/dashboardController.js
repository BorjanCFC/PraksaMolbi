const { Molba, Student } = require('../models');

// GET /dashboard - prikazi dashboard so molbi na studentot
exports.getDashboard = async (req, res) => {
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

    // Vkupno molbi (bez filter) za statistika
    const siteMolbi = await Molba.findAll({
      where: { studentId: req.session.studentId }
    });

    res.render('dashboard', {
      title: 'Dashboard',
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

// GET /dashboard/nova-molba - forma za nova molba
exports.getnovaMolba = (req, res) => {
  res.render('nova-molba', {
    title: 'Нова молба',
    studentName: req.session.studentName,
    error: req.flash('error')
  });
};

// POST /dashboard/nova-molba - kreiranje nova molba
exports.postNovaMolba = async (req, res) => {
  try {
    const { description } = req.body;

    if (!description || description.trim() === '') {
      req.flash('error', 'Описот е задолжителен.');
      return res.redirect('/dashboard/nova-molba');
    }

    await Molba.create({
      studentId: req.session.studentId,
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

// GET /dashboard/molba/:id - detali za molba
exports.getMolbaDetail = async (req, res) => {
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
