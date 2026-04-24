const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const PDFDocument = require('pdfkit');
const {
  Molba,
  User,
  Student
} = require('../models');
const {
  ROLE,
  getRoleLabel,
  isStudentRole,
  isStaffRole,
  canManageMolbi
} = require('../utils/roleHelpers');

const allowedStatuses = new Set(['Во процес', 'Одобрена', 'Одбиена']);
const allowedSemestri = new Set(['Зимски', 'Летен']);
const academicYearPattern = /^\d{4}\/\d{4}$/;
const projectRoot = path.join(__dirname, '..');
const archivePdfRelativeDir = path.join('uploads', 'archive');

const molbaStudentInclude = [{
  model: User,
  as: 'student',
  include: [{ model: Student, as: 'studentProfile' }]
}];
const toPosixPath = (value) => value.replace(/\\/g, '/');

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const getWindowsCyrillicFonts = () => {
  const candidates = [
    { regular: 'C:/Windows/Fonts/times.ttf', bold: 'C:/Windows/Fonts/timesbd.ttf' },
    { regular: 'C:/Windows/Fonts/arial.ttf', bold: 'C:/Windows/Fonts/arialbd.ttf' },
    { regular: 'C:/Windows/Fonts/segoeui.ttf', bold: 'C:/Windows/Fonts/segoeuib.ttf' }
  ];

  return candidates.find((fontSet) => fs.existsSync(fontSet.regular) && fs.existsSync(fontSet.bold)) || null;
};

const formatDateMk = (value) => {
  if (!value) return '-';

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-');
    return `${day}.${month}.${year}`;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
};

const generateArchivePdfFile = async (molba) => {
  const archiveDir = path.join(projectRoot, archivePdfRelativeDir);
  ensureDir(archiveDir);

  const fileName = `molba-${molba.molbaId}-${Date.now()}.pdf`;
  const fullPath = path.join(archiveDir, fileName);
  const relativePath = toPosixPath(path.join('uploads', 'archive', fileName));

  const studentName = `${molba.student.ime} ${molba.student.prezime}`.trim();
  const indexValue = molba.student.brIndeks || 'N/A';
  const majorValue = molba.student.smer || 'N/A';
  const titleValue = molba.naslov || 'Bez naslov';
  const archiveNumberValue = molba.arhivskiBroj || 'Nema arhivski broj';
  const semesterValue = molba.semestar || 'N/A';
  const academicYearValue = molba.ucebnaGodina || 'N/A';
  const submitDateValue = formatDateMk(molba.datum);
  const descriptionValue = (molba.description || '').trim();
  const statusValue = molba.status || 'Во процес';
  const rejectionReasonValue = molba.feedback && molba.feedback.trim() !== '' ? molba.feedback.trim() : '-';

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: {
        top: 56,
        left: 56,
        right: 56,
        bottom: 56
      }
    });

    const stream = fs.createWriteStream(fullPath);
    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.on('error', reject);

    doc.pipe(stream);

    const cyrillicFonts = getWindowsCyrillicFonts();
    if (cyrillicFonts) {
      doc.registerFont('pdf-regular', cyrillicFonts.regular);
      doc.registerFont('pdf-bold', cyrillicFonts.bold);
    }

    const regularFont = cyrillicFonts ? 'pdf-regular' : 'Helvetica';
    const boldFont = cyrillicFonts ? 'pdf-bold' : 'Helvetica-Bold';
    const logoPath = path.join(projectRoot, 'public', 'images', 'feitlogoMolba.png');

    const drawLabelValue = (x, y, label, value, options = {}) => {
      const {
        labelSize = 18,
        valueSize = 18,
        maxWidth = 470,
        lineGap = 3
      } = options;

      doc.font(boldFont).fontSize(labelSize).fillColor('#000000').text(label, x, y, {
        continued: true
      });

      doc.font(regularFont).fontSize(valueSize).text(` ${value}`, {
        width: maxWidth,
        lineGap
      });
    };

    if (fs.existsSync(logoPath)) {
      // Place institution logo in the top-left corner.
      doc.image(logoPath, 56, 48, {
        fit: [120, 80],
        align: 'left',
        valign: 'top'
      });
    }

    doc.font(boldFont).fontSize(34).fillColor('#000000').text('Молба', 0, 74, {
      align: 'center'
    });

    drawLabelValue(385, 88, 'Датум:', submitDateValue, {
      labelSize: 15,
      valueSize: 15,
      maxWidth: 160
    });

    drawLabelValue(385, 116, 'Архивски број:', archiveNumberValue, {
      labelSize: 15,
      valueSize: 15,
      maxWidth: 170
    });

    drawLabelValue(72, 210, 'Наслов на молбата:', titleValue, {
      labelSize: 16,
      valueSize: 16,
      maxWidth: 470
    });

    drawLabelValue(72, 280, 'Студент:', `${studentName} ${indexValue} ${majorValue}`, {
      labelSize: 16,
      valueSize: 16,
      maxWidth: 470
    });

    drawLabelValue(72, 310, 'Семестар и учебна година:', `${semesterValue} ${academicYearValue}`, {
      labelSize: 16,
      valueSize: 16,
      maxWidth: 470
    });

    drawLabelValue(72, 390, 'Опис на молбата:', descriptionValue || '-', {
      labelSize: 16,
      valueSize: 16,
      maxWidth: 470,
      lineGap: 4
    });

    drawLabelValue(72, 720, 'Статус:', statusValue, {
      labelSize: 16,
      valueSize: 16,
      maxWidth: 470
    });

    if (statusValue === 'Одбиена') {
      drawLabelValue(72, 750, 'Причина за одбивање:', rejectionReasonValue, {
        labelSize: 16,
        valueSize: 16,
        maxWidth: 470,
        lineGap: 3
      });
    }

    doc.end();
  });

  return relativePath;
};

const getSessionUser = (req) => (req.session && req.session.user ? req.session.user : null);

const requireAuth = (req, res) => {
  const user = getSessionUser(req);
  if (user) return user;
  req.flash('error', 'Ве молиме најавете се.');
  res.redirect('/login');
  return null;
};

const requireStudent = (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (isStudentRole(user.role)) return user;
  req.flash('error', 'Оваа страница е достапна само за студенти.');
  res.redirect('/dashboard');
  return null;
};

const requireStaff = (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (isStaffRole(user.role)) return user;
  req.flash('error', 'Немате дозвола за оваа акција.');
  res.redirect('/dashboard');
  return null;
};

const resolveUploadPath = (relativePath) => {
  if (!relativePath) return null;
  const normalized = path.normalize(relativePath);
  return path.join(projectRoot, normalized);
};

const addDateFilter = (whereClause, fromDate, toDate) => {
  if (fromDate && toDate) {
    whereClause.datum = { [Op.between]: [fromDate, toDate] };
    return;
  }

  if (fromDate) {
    whereClause.datum = { [Op.gte]: fromDate };
    return;
  }

  if (toDate) {
    whereClause.datum = { [Op.lte]: toDate };
  }
};

const requiresArchiveNumberBeforeReview = (role) => (
  role === ROLE.STUDENTSKA_SLUZHBA || role === ROLE.PRODEKAN
);

// GET /dashboard
exports.getDashboard = async (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  try {
    const {
      status,
      semestar,
      fromDate,
      toDate
    } = req.query;

    if (isStudentRole(user.role)) {
      const student = await User.findByPk(user.userId, {
        include: [{ model: Student, as: 'studentProfile' }]
      });

      const whereClause = { userId: user.userId };
      if (status && status !== 'site') {
        whereClause.status = status;
      }
      if (semestar && semestar !== 'site' && allowedSemestri.has(semestar)) {
        whereClause.semestar = semestar;
      }
      addDateFilter(whereClause, fromDate, toDate);

      const molbi = await Molba.findAll({
        where: whereClause,
        order: [['datum', 'DESC']]
      });

      const siteMolbi = await Molba.findAll({ where: { userId: user.userId } });

      return res.render('dashboard', {
        title: 'Dashboard',
        viewer: user,
        getRoleLabel,
        isImpersonating: false,
        isStudent: true,
        canManage: false,
        student,
        molbi,
        siteMolbi,
        currentStatus: status || 'site',
        currentSemestar: semestar || 'site',
        currentFromDate: fromDate || '',
        currentToDate: toDate || '',
        success: req.flash('success'),
        error: req.flash('error')
      });
    }

    const whereClause = {};
    if (requiresArchiveNumberBeforeReview(user.role)) {
      whereClause.arhivskiBroj = { [Op.not]: null };
    }

    if (status && status !== 'site') {
      whereClause.status = status;
    }
    if (semestar && semestar !== 'site' && allowedSemestri.has(semestar)) {
      whereClause.semestar = semestar;
    }
    addDateFilter(whereClause, fromDate, toDate);

    const molbi = await Molba.findAll({
      where: whereClause,
      include: molbaStudentInclude,
      order: [['datum', 'DESC']]
    });

    const statsWhereClause = {};
    if (requiresArchiveNumberBeforeReview(user.role)) {
      statsWhereClause.arhivskiBroj = { [Op.not]: null };
    }

    const allMolbi = await Molba.findAll({
      where: statsWhereClause,
      include: molbaStudentInclude
    });

    molbi.forEach((item) => {
      if (item.student) {
        item.student.setDataValue('brIndeks', item.student.studentProfile ? item.student.studentProfile.brIndeks : null);
        item.student.setDataValue('smer', item.student.studentProfile ? item.student.studentProfile.smer : null);
      }
    });

    return res.render('dashboard', {
      title: 'Dashboard',
      viewer: user,
      getRoleLabel,
      isImpersonating: false,
      isStudent: false,
      canManage: canManageMolbi(user.role),
      molbi,
      stats: {
        vkupno: allMolbi.length,
        voProces: allMolbi.filter((m) => m.status === 'Во процес').length,
        odobreni: allMolbi.filter((m) => m.status === 'Одобрена').length,
        odbieni: allMolbi.filter((m) => m.status === 'Одбиена').length
      },
      currentStatus: status || 'site',
      currentSemestar: semestar || 'site',
      currentFromDate: fromDate || '',
      currentToDate: toDate || '',
      success: req.flash('success'),
      error: req.flash('error')
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    req.flash('error', 'Настана грешка при вчитување.');
    return res.redirect('/login');
  }
};

// GET /dashboard/nova-molba
exports.getNovaMolba = (req, res) => {
  const user = requireStudent(req, res);
  if (!user) return;

  res.render('nova-molba', {
    title: 'Нова молба',
    viewer: user,
    isImpersonating: false,
    error: req.flash('error')
  });
};

// POST /dashboard/nova-molba
exports.postNovaMolba = async (req, res) => {
  const user = requireStudent(req, res);
  if (!user) return;

  try {
    const { naslov, semestar, ucebnaGodina, description } = req.body;

    if (!naslov || naslov.trim() === '') {
      req.flash('error', 'Насловот е задолжителен.');
      return res.redirect('/dashboard/nova-molba');
    }

    if (!semestar || !allowedSemestri.has(semestar)) {
      req.flash('error', 'Семестарот мора да биде Зимски или Летен.');
      return res.redirect('/dashboard/nova-molba');
    }

    if (!ucebnaGodina || !academicYearPattern.test(ucebnaGodina.trim())) {
      req.flash('error', 'Учебната година мора да биде во формат ГГГГ/ГГГГ (пример 2025/2026).');
      return res.redirect('/dashboard/nova-molba');
    }

    const [startYear, endYear] = ucebnaGodina.trim().split('/').map(Number);
    if (endYear !== startYear + 1) {
      req.flash('error', 'Учебната година не е валидна. Втората година мора да е следна (пример 2025/2026).');
      return res.redirect('/dashboard/nova-molba');
    }

    const cleanDescription = description && description.trim() !== '' ? description.trim() : '';
    if (!cleanDescription) {
      req.flash('error', 'Текстот на молбата е задолжителен.');
      return res.redirect('/dashboard/nova-molba');
    }

    if (!req.file) {
      req.flash('error', 'Прикачување PDF документ е задолжително.');
      return res.redirect('/dashboard/nova-molba');
    }

    await Molba.create({
      userId: user.userId,
      naslov: naslov.trim(),
      semestar,
      ucebnaGodina: ucebnaGodina.trim(),
      description: cleanDescription,
      status: 'Во процес',
      datum: new Date(),
      arhivskiBroj: null,
      urlPath: toPosixPath(path.join('uploads', 'student', req.file.filename))
    });

    req.flash('success', 'Молбата е успешно испратена во архива.');
    return res.redirect('/dashboard');
  } catch (error) {
    console.error('Create molba error:', error);
    req.flash('error', 'Настана грешка при креирање на молбата.');
    return res.redirect('/dashboard/nova-molba');
  }
};

// GET /dashboard/molba/:id
exports.getMolbaDetail = async (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  try {
    const whereClause = { molbaId: req.params.id };
    if (isStudentRole(user.role)) {
      whereClause.userId = user.userId;
    }

    const molba = await Molba.findOne({
      where: whereClause,
      include: molbaStudentInclude
    });

    if (!molba) {
      req.flash('error', 'Молбата не е пронајдена.');
      return res.redirect('/dashboard');
    }

    if (requiresArchiveNumberBeforeReview(user.role) && !molba.arhivskiBroj) {
      req.flash('error', 'Оваа молба уште не е архивирана и не е достапна за обработка.');
      return res.redirect('/dashboard');
    }

    if (molba.student) {
      molba.student.setDataValue('brIndeks', molba.student.studentProfile ? molba.student.studentProfile.brIndeks : null);
      molba.student.setDataValue('smer', molba.student.studentProfile ? molba.student.studentProfile.smer : null);
    }

    return res.render('molba-detail', {
      title: `Молба #${molba.molbaId}`,
      viewer: user,
      isImpersonating: false,
      isStudent: isStudentRole(user.role),
      canManage: canManageMolbi(user.role),
      canArchiveNumber: user.role === ROLE.ARHIVA,
      canGenerateArchivePdf: user.role === ROLE.ARHIVA
        && (molba.status === 'Одобрена' || molba.status === 'Одбиена')
        && !molba.arhivaPdfPath,
      molba,
      success: req.flash('success'),
      error: req.flash('error')
    });
  } catch (error) {
    console.error('Molba detail error:', error);
    req.flash('error', 'Настана грешка.');
    return res.redirect('/dashboard');
  }
};

// POST /dashboard/molba/:id/generate-archive-pdf
exports.generateArchivePdf = async (req, res) => {
  const user = requireStaff(req, res);
  if (!user) return;

  if (user.role !== ROLE.ARHIVA) {
    req.flash('error', 'Само архивата може да генерира PDF од молба.');
    return res.redirect('/dashboard');
  }

  try {
    const molba = await Molba.findByPk(req.params.id, {
      include: molbaStudentInclude
    });

    if (!molba) {
      req.flash('error', 'Молбата не е пронајдена.');
      return res.redirect('/dashboard');
    }

    if (molba.status !== 'Одобрена' && molba.status !== 'Одбиена') {
      req.flash('error', 'PDF може да се генерира само за одобрена или одбиена молба.');
      return res.redirect(`/dashboard/molba/${req.params.id}`);
    }

    if (!molba.arhivskiBroj) {
      req.flash('error', 'Прво внесете архивски број, па потоа генерирајте PDF.');
      return res.redirect(`/dashboard/molba/${req.params.id}`);
    }

    if (molba.arhivaPdfPath) {
      req.flash('error', 'PDF за оваа молба е веќе генериран.');
      return res.redirect(`/dashboard/molba/${req.params.id}`);
    }

    if (molba.student) {
      molba.student.setDataValue('brIndeks', molba.student.studentProfile ? molba.student.studentProfile.brIndeks : null);
      molba.student.setDataValue('smer', molba.student.studentProfile ? molba.student.studentProfile.smer : null);
    }

    molba.arhivaPdfPath = await generateArchivePdfFile(molba);
    await molba.save();

    req.flash('success', 'PDF документот е успешно генериран.');
    return res.redirect(`/dashboard/molba/${req.params.id}`);
  } catch (error) {
    console.error('Generate archive pdf error:', error);
    req.flash('error', 'Настана грешка при генерирање на PDF документот.');
    return res.redirect(`/dashboard/molba/${req.params.id}`);
  }
};

// POST /dashboard/molba/:id/status
exports.updateStatus = async (req, res) => {
  const user = requireStaff(req, res);
  if (!user) return;

  if (!canManageMolbi(user.role)) {
    req.flash('error', 'Немате дозвола за промена на статус.');
    return res.redirect('/dashboard');
  }

  try {
    const { status, feedback } = req.body;

    if (!allowedStatuses.has(status)) {
      req.flash('error', 'Невалиден статус.');
      return res.redirect('/dashboard');
    }

    const molba = await Molba.findByPk(req.params.id, {
      include: molbaStudentInclude
    });

    if (!molba) {
      req.flash('error', 'Молбата не е пронајдена.');
      return res.redirect('/dashboard');
    }

    if (requiresArchiveNumberBeforeReview(user.role) && !molba.arhivskiBroj) {
      req.flash('error', 'Молбата не може да се обработи пред да се внесе архивски број.');
      return res.redirect(`/dashboard/molba/${req.params.id}`);
    }

    molba.status = status;
    molba.feedback = feedback && feedback.trim() !== '' ? feedback.trim() : null;

    await molba.save();

    req.flash('success', 'Успешно зачуван статус на молбата.');
    return res.redirect('/dashboard');
  } catch (error) {
    console.error('Update status error:', error);
    req.flash('error', 'Настана грешка при ажурирање.');
    return res.redirect('/dashboard');
  }
};

// GET /dashboard/molba/:id/document/archive
exports.downloadArchivePdf = async (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  try {
    const whereClause = { molbaId: req.params.id };
    if (isStudentRole(user.role)) {
      whereClause.userId = user.userId;
    }

    const molba = await Molba.findOne({ where: whereClause });
    if (!molba || !molba.arhivaPdfPath) {
      req.flash('error', 'Генерираниот PDF не е пронајден.');
      return res.redirect(`/dashboard/molba/${req.params.id}`);
    }

    const fullPath = resolveUploadPath(molba.arhivaPdfPath);
    if (!fullPath || !fs.existsSync(fullPath)) {
      req.flash('error', 'PDF документот физички не постои.');
      return res.redirect(`/dashboard/molba/${req.params.id}`);
    }

    return res.download(fullPath, path.basename(fullPath));
  } catch (error) {
    console.error('Download archive pdf error:', error);
    req.flash('error', 'Настана грешка при симнување на PDF документот.');
    return res.redirect(`/dashboard/molba/${req.params.id}`);
  }
};

// POST /dashboard/molba/:id/archive-number
exports.updateArchiveNumber = async (req, res) => {
  const user = requireStaff(req, res);
  if (!user) return;

  if (user.role !== ROLE.ARHIVA) {
    req.flash('error', 'Само архивата може да внесе архивски број.');
    return res.redirect('/dashboard');
  }

  try {
    const { arhivskiBroj } = req.body;
    const cleanArchiveNumber = arhivskiBroj && arhivskiBroj.trim() !== '' ? arhivskiBroj.trim() : '';

    if (!cleanArchiveNumber) {
      req.flash('error', 'Архивскиот број е задолжителен.');
      return res.redirect(`/dashboard/molba/${req.params.id}`);
    }

    const molba = await Molba.findByPk(req.params.id);
    if (!molba) {
      req.flash('error', 'Молбата не е пронајдена.');
      return res.redirect('/dashboard');
    }

    if (molba.arhivskiBroj) {
      req.flash('error', 'Оваа молба веќе има архивски број.');
      return res.redirect(`/dashboard/molba/${req.params.id}`);
    }

    molba.arhivskiBroj = cleanArchiveNumber;
    await molba.save();

    req.flash('success', 'Архивскиот број е успешно зачуван.');
    return res.redirect(`/dashboard/molba/${req.params.id}`);
  } catch (error) {
    if (error && error.name === 'SequelizeUniqueConstraintError') {
      req.flash('error', 'Архивскиот број мора да биде уникатен. Внесете друг број.');
      return res.redirect(`/dashboard/molba/${req.params.id}`);
    }

    console.error('Update archive number error:', error);
    req.flash('error', 'Настана грешка при зачувување на архивскиот број.');
    return res.redirect(`/dashboard/molba/${req.params.id}`);
  }
};

// GET /dashboard/molba/:id/document/student
exports.downloadStudentDocument = async (req, res) => {
  const user = requireAuth(req, res);
  if (!user) return;

  try {
    const whereClause = { molbaId: req.params.id };
    if (isStudentRole(user.role)) {
      whereClause.userId = user.userId;
    }

    const molba = await Molba.findOne({ where: whereClause });
    if (!molba || !molba.urlPath) {
      req.flash('error', 'Документот не е пронајден.');
      return res.redirect('/dashboard');
    }

    const fullPath = resolveUploadPath(molba.urlPath);
    if (!fullPath || !fs.existsSync(fullPath)) {
      req.flash('error', 'Документот физички не постои.');
      return res.redirect('/dashboard');
    }

    return res.download(fullPath, path.basename(fullPath));
  } catch (error) {
    console.error('Download student document error:', error);
    req.flash('error', 'Настана грешка при симнување.');
    return res.redirect('/dashboard');
  }
};

