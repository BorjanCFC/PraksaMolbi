const { Molba, Student } = require('../models');

// GET /admin/dashboard - site molbi
exports.getDashboard = async (req, res) => {
  try {
    const { status, studentId } = req.query;

    const whereClause = {};
    if (status && status !== 'site') {
      whereClause.status = status;
    }
    if (studentId && studentId !== 'site') {
      whereClause.studentId = parseInt(studentId);
    }

    const molbi = await Molba.findAll({
      where: whereClause,
      include: [{ model: Student, as: 'student' }],
      order: [['datum', 'DESC']]
    });

    // Vkupno molbi (bez filter) za statistika
    const siteMolbi = await Molba.findAll({
      include: [{ model: Student, as: 'student' }]
    });

    // Lista na site studenti za filter dropdown
    const studenti = await Student.findAll({
      order: [['ime', 'ASC']]
    });

    const stats = {
      vkupno: siteMolbi.length,

      voProces: siteMolbi.filter(m => m.status === 'Во процес').length,
      odobreni: siteMolbi.filter(m => m.status === 'Одобрена').length,
      odbieni: siteMolbi.filter(m => m.status === 'Одбиена').length
    };

    res.render('admin/dashboard', {
      title: 'Студентска Служба - Dashboard',
      adminName: req.session.adminName,
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
    res.redirect('/admin/login');
  }
};

// GET /admin/molba/:id - detali za molba
exports.getMolbaDetail = async (req, res) => {
  try {
    const molba = await Molba.findByPk(req.params.id, {
      include: [{ model: Student, as: 'student' }]
    });

    if (!molba) {
      req.flash('error', 'Молбата не е пронајдена.');
      return res.redirect('/admin/dashboard');
    }

    res.render('admin/molba-detail', {
      title: `Молба #${molba.molbaId}`,
      adminName: req.session.adminName,
      molba,
      success: req.flash('success'),
      error: req.flash('error')
    });
  } catch (error) {
    console.error('Admin molba detail error:', error);
    req.flash('error', 'Настана грешка.');
    res.redirect('/admin/dashboard');
  }
};

// POST /admin/molba/:id/status - promeni status
exports.updateStatus = async (req, res) => {
  try {
    const { status, feedback } = req.body;
    const molba = await Molba.findByPk(req.params.id);

    if (!molba) {
      req.flash('error', 'Молбата не е пронајдена.');
      return res.redirect('/admin/dashboard');
    }

    molba.status = status;
    if (feedback && feedback.trim() !== '') {
      molba.feedback = feedback.trim();
    }
    await molba.save();

    req.flash('success', `Статусот на молба #${molba.molbaId} е ажуриран на "${status}".`);
    res.redirect(`/admin/molba/${molba.molbaId}`);
  } catch (error) {
    console.error('Update status error:', error);
    req.flash('error', 'Настана грешка при ажурирање.');
    res.redirect('/admin/dashboard');
  }
};
