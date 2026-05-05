const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const PDFDocument = require('pdfkit');
const {
  Molba,
  User,
  Student,
  Role
} = require('../models');
const {
  ROLE,
  getRoleLabel,
  isStudentRole,
  isStaffRole,
  canManageMolbi
} = require('../utils/roleHelpers');
const {
  sendMolbaCreatedEmail,
  sendMolbaApprovedEmail,
  sendMolbaRejectedEmail
} = require('../utils/emailService');
const {
  convertNameToCyrillic
} = require('../utils/cyrillicConverter');
const {
  getStudentDocumentPath,
  getArchivePath
} = require('../utils/uploadPathHelper');

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

const findFileInUploadsByName = (fileName) => {
  const uploadsRoot = path.join(projectRoot, 'uploads');

  const search = (dirPath) => {
    if (!fs.existsSync(dirPath)) return null;

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isFile() && entry.name === fileName) {
        return fullPath;
      }

      if (entry.isDirectory()) {
        const nested = search(fullPath);
        if (nested) return nested;
      }
    }

    return null;
  };

  return search(uploadsRoot);
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

const sanitizePdfText = (value) => {
  if (value === null || value === undefined) return '';

  return String(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD\u25A1]/g, '')
    .trim();
};

const generateArchivePdfFile = async (molba) => {
  const archiveDir = path.join(projectRoot, archivePdfRelativeDir);
  const nasoka = molba.student.smer || (molba.student.studentProfile ? molba.student.studentProfile.smer : null) || 'unknown';
  const relArchivePath = getArchivePath(nasoka, molba.student.ime, molba.student.prezime);
  const specificArchiveDir = path.join(projectRoot, 'uploads', relArchivePath);
  
  ensureDir(specificArchiveDir);

  const fileName = `molba-${molba.molbaId}-${Date.now()}.pdf`;
  const fullPath = path.join(specificArchiveDir, fileName);
  const relativePath = toPosixPath(path.join(relArchivePath, fileName));

  const studentProfile = molba.student && molba.student.studentProfile ? molba.student.studentProfile : null;
  const studentName = `${convertNameToCyrillic(molba.student.ime)} ${convertNameToCyrillic(molba.student.prezime)}`.trim();
  const indexValue = molba.student.brIndeks || (studentProfile ? studentProfile.brIndeks : null) || '-';
  const majorValue = molba.student.smer || (studentProfile ? studentProfile.smer : null) || '-';
  const titleValue = sanitizePdfText(molba.naslov) || 'Без наслов';
  const archiveNumberValue = molba.arhivskiBroj || '-';
  const semesterValue = molba.semestar || '-';
  const academicYearValue = molba.ucebnaGodina || '-';
  const submitDateValue = formatDateMk(molba.datum);
  const descriptionValue = sanitizePdfText(molba.description);
  const statusValue = molba.status || 'Во процес';
  const feedbackValue = sanitizePdfText(molba.feedback);
  const shouldRenderFeedback = statusValue === 'Одбиена' && feedbackValue !== '';
  const studentLine = [studentName, indexValue, majorValue].filter(Boolean).join(' ');

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
    const ukimLogoPath = path.join(projectRoot, 'public', 'images', 'ukim-logo.png');
    const feitRightLogoPath = path.join(projectRoot, 'public', 'images', 'feitLogoBrowser.png');

    if (fs.existsSync(ukimLogoPath)) {
      doc.image(ukimLogoPath, 52, 52, {
        fit: [68, 68],
        align: 'left',
        valign: 'top'
      });
    }

    if (fs.existsSync(feitRightLogoPath)) {
      doc.image(feitRightLogoPath, 492, 52, {
        fit: [64, 64],
        align: 'right',
        valign: 'top'
      });
    }

    doc.fillColor('#000000');

    const headerX = 130;
    const headerWidth = 340;

    doc.font(boldFont).fontSize(14).text('УНИВЕРЗИТЕТ “Св. КИРИЛ И МЕТОДИЈ” -', headerX, 58, {
      width: headerWidth,
      align: 'center'
    });
    doc.font(boldFont).fontSize(14).text('СКОПЈЕ', headerX, 80, {
      width: headerWidth,
      align: 'center'
    });
    doc.font(boldFont).fontSize(14).text('ФАКУЛТЕТ ЗА ЕЛЕКТРОТЕХНИКА И', headerX, 110, {
      width: headerWidth,
      align: 'center'
    });
    doc.font(boldFont).fontSize(14).text('ИНФОРМАЦИСКИ ТЕХНОЛОГИИ', headerX, 132, {
      width: headerWidth,
      align: 'center'
    });

    doc.font(boldFont).fontSize(13).text('Датум:', 72, 190, { continued: true });
    doc.font(regularFont).fontSize(13).text(` ${submitDateValue}`);

    doc.font(boldFont).fontSize(13).text('Архивски број:', 350, 190, { continued: true });
    doc.font(regularFont).fontSize(13).text(` ${archiveNumberValue}`);

    doc.font(boldFont).fontSize(18).text('Молба', 0, 245, {
      align: 'center'
    });

    let y = 315;
    const leftX = 72;
    const contentWidth = 450;
    const labelFontSize = 14;
    const valueFontSize = 14;

    doc.font(boldFont).fontSize(labelFontSize).text('Наслов на молбата:', leftX, y, {
      continued: true
    });
    doc.font(regularFont).fontSize(valueFontSize).text(` ${titleValue}`, {
      width: contentWidth,
      lineGap: 3
    });
    y = doc.y + 14;

    doc.font(boldFont).fontSize(labelFontSize).text('Студент:', leftX, y, {
      continued: true
    });
    doc.font(regularFont).fontSize(valueFontSize).text(` ${studentLine}`, {
      width: contentWidth,
      lineGap: 3
    });
    y = doc.y + 14;

    doc.font(boldFont).fontSize(labelFontSize).text('Семестар и учебна година:', leftX, y, {
      continued: true
    });
    doc.font(regularFont).fontSize(valueFontSize).text(` ${semesterValue} ${academicYearValue}`, {
      width: contentWidth,
      lineGap: 3
    });
    y = doc.y + 18;

    doc.font(boldFont).fontSize(labelFontSize).text('Опис на молбата:', leftX, y, {
      continued: true
    });
    doc.font(regularFont).fontSize(valueFontSize).text(` ${descriptionValue || '-'}`, {
      width: contentWidth,
      lineGap: 4
    });

    const footerY = doc.y + 35;

    doc.font(boldFont).fontSize(labelFontSize).text('Статус:', leftX, footerY, {
      continued: true
    });
    doc.font(regularFont).fontSize(valueFontSize).text(` ${statusValue}`);

    if (shouldRenderFeedback) {
      doc.font(boldFont).fontSize(17).text('Повратна информација:', 72, footerY + 36, { continued: true });
      doc.font(regularFont).fontSize(17).text(` ${feedbackValue}`, {
        width: 450,
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

  const candidates = [];

  if (path.isAbsolute(normalized)) {
    candidates.push(normalized);
  } else {
    if (normalized.startsWith(`uploads${path.sep}`)) {
      candidates.push(path.join(projectRoot, normalized));
    } else {
      candidates.push(
        path.join(projectRoot, 'uploads', normalized),
        path.join(projectRoot, normalized)
      );
    }
  }

  for (const candidatePath of candidates) {
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  const fallbackFileName = path.basename(normalized);
  return findFileInUploadsByName(fallbackFileName);
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

const assignableStaffRoles = new Set([
  ROLE.ADMIN,
  ROLE.STUDENTSKA_SLUZHBA,
  ROLE.PRODEKAN,
  ROLE.ARHIVA
]);

const roleTipByRole = {
  [ROLE.ADMIN]: 'Admin',
  [ROLE.STUDENTSKA_SLUZHBA]: 'Sluzhba',
  [ROLE.PRODEKAN]: 'Prodekan',
  [ROLE.ARHIVA]: 'Arhiva'
};

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const toNamePart = (value, fallback) => {
  const clean = String(value || '').trim();
  if (!clean) return fallback;
  return clean.charAt(0).toUpperCase() + clean.slice(1);
};

const deriveNameFromEmail = (email) => {
  const localPart = (email.split('@')[0] || '').trim();
  const parts = localPart.split(/[._-]+/).filter(Boolean);

  return {
    ime: toNamePart(parts[0], 'Корисник'),
    prezime: toNamePart(parts.slice(1).join(' '), 'Профил')
  };
};

const newestFirstOrder = [['createdAt', 'DESC'], ['molbaId', 'DESC']];

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

      if (student && student.studentProfile) {
        user.brIndeks = student.studentProfile.brIndeks || null;
        user.smer = student.studentProfile.smer || null;

        if (req.session && req.session.user) {
          req.session.user.brIndeks = user.brIndeks;
          req.session.user.smer = user.smer;
        }
      }

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
        order: newestFirstOrder
      });

      const siteMolbi = await Molba.findAll({ where: { userId: user.userId } });

      return res.render('dashboard', {
        title: 'Dashboard',
        viewer: user,
        getRoleLabel,
        convertNameToCyrillic,
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
      order: newestFirstOrder
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
      convertNameToCyrillic,
      isImpersonating: false,
      isStudent: false,
      isGlobalAdmin: user.role === ROLE.ADMIN,
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

// POST /dashboard/assign-role
exports.assignRoleByEmail = async (req, res) => {
  const user = requireStaff(req, res);
  if (!user) return;

  if (user.role !== ROLE.ADMIN) {
    req.flash('error', 'Само админ може да доделува улоги.');
    return res.redirect('/dashboard');
  }

  try {
    const email = normalizeEmail(req.body.email);
    const role = String(req.body.role || '').trim();

    if (!email || !isValidEmail(email)) {
      req.flash('error', 'Внесете валиден email.');
      return res.redirect('/dashboard');
    }

    if (!assignableStaffRoles.has(role)) {
      req.flash('error', 'Избраната улога не е валидна за доделување.');
      return res.redirect('/dashboard');
    }

    const roleTip = roleTipByRole[role];
    const dbRole = await Role.findOne({ where: { tip: roleTip } });
    if (!dbRole) {
      req.flash('error', 'Бараната улога не постои во базата.');
      return res.redirect('/dashboard');
    }

    let targetUser = await User.findOne({
      where: { email },
      include: [{ model: Student, as: 'studentProfile', required: false }]
    });

    if (!targetUser) {
      const nameParts = deriveNameFromEmail(email);
      targetUser = await User.create({
        ime: nameParts.ime,
        prezime: nameParts.prezime,
        email,
        password: null,
        provider: 'microsoft',
        providerId: null,
        roleId: dbRole.roleId
      });
    } else {
      targetUser.roleId = dbRole.roleId;
      await targetUser.save();

      if (targetUser.studentProfile) {
        await Student.destroy({ where: { userId: targetUser.userId } });
      }
    }

    req.flash('success', `Улогата "${getRoleLabel(role)}" е доделена за ${email}.`);
    return res.redirect('/dashboard');
  } catch (error) {
    console.error('Assign role error:', error);
    req.flash('error', 'Настана грешка при доделување улога.');
    return res.redirect('/dashboard');
  }
};

// GET /dashboard/nova-molba
exports.getNovaMolba = (req, res) => {
  const user = requireStudent(req, res);
  if (!user) return;

  res.render('nova-molba', {
    title: 'Нова молба',
    viewer: user,
    getRoleLabel,
    convertNameToCyrillic,
    isImpersonating: false,
    error: req.flash('error')
  });
};

// POST /dashboard/nova-molba
exports.postNovaMolba = async (req, res) => {
  const user = requireStudent(req, res);
  if (!user) return;

  try {
    const { naslov, semestar, ucebnaGodina, description, brIndeks, smer } = req.body;

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

    if (!brIndeks || brIndeks.trim() === '') {
      req.flash('error', 'Бројот на индекс е задолжителен.');
      return res.redirect('/dashboard/nova-molba');
    }

    if (!smer || smer.trim() === '') {
      req.flash('error', 'Насоката е задолжителна.');
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

    // Ensure student profile exists and always persist latest index/major for this student.
    await Student.upsert({
      userId: user.userId,
      brIndeks: brIndeks.trim(),
      smer: smer.trim()
    });

    if (req.session && req.session.user) {
      req.session.user.brIndeks = brIndeks.trim();
      req.session.user.smer = smer.trim();
    }

    const newMolba = await Molba.create({
      userId: user.userId,
      naslov: naslov.trim(),
      semestar,
      ucebnaGodina: ucebnaGodina.trim(),
      description: cleanDescription,
      status: 'Во процес',
      datum: new Date(),
      arhivskiBroj: null,
      urlPath: toPosixPath(path.join(getStudentDocumentPath(smer.trim(), user.ime, user.prezime), req.file.filename))
    });

    // Send confirmation email to student (fire-and-forget - don't wait)
    if (user.email) {
      const studentFullName = `${user.ime} ${user.prezime}`;
      console.log('[Controller] Triggering email send for:', user.email);
      sendMolbaCreatedEmail(user.email, studentFullName, naslov.trim());
    } else {
      console.warn('[Controller] User email not found for user:', user.userId);
    }

    req.flash('success', 'Молбата е успешно пратена.');
    return res.redirect('/dashboard');
  } catch (error) {
    if (error && error.name === 'SequelizeUniqueConstraintError') {
      req.flash('error', 'Бројот на индекс веќе постои. Внесете валиден и уникатен број на индекс.');
      return res.redirect('/dashboard/nova-molba');
    }

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

      if (isStudentRole(user.role) && molba.student.userId === user.userId && req.session && req.session.user) {
        req.session.user.brIndeks = molba.student.studentProfile ? molba.student.studentProfile.brIndeks : null;
        req.session.user.smer = molba.student.studentProfile ? molba.student.studentProfile.smer : null;
        user.brIndeks = req.session.user.brIndeks;
        user.smer = req.session.user.smer;
      }
    }

    return res.render('molba-detail', {
      title: `Молба #${molba.molbaId}`,
      viewer: user,
      getRoleLabel,
      convertNameToCyrillic,
      isImpersonating: false,
      isStudent: isStudentRole(user.role),
      canManage: canManageMolbi(user.role),
      canArchiveNumber: user.role === ROLE.ARHIVA,
      canGenerateMolbaPdf: user.role === ROLE.STUDENTSKA_SLUZHBA
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

  if (user.role !== ROLE.STUDENTSKA_SLUZHBA) {
    req.flash('error', 'Само студентската служба може да генерира PDF од молба.');
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

// POST /dashboard/molba/:id/generate-molba-pdf
exports.generateMolbaPdf = async (req, res) => {
  const user = requireStaff(req, res);
  if (!user) return;

  if (user.role !== ROLE.STUDENTSKA_SLUZHBA) {
    req.flash('error', 'Само студентска служба може да генерира PDF на молба.');
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

    // Send email to student (fire-and-forget)
    if (molba.student && molba.student.email) {
      const studentFullName = `${molba.student.ime} ${molba.student.prezime}`;
      
      if (molba.status === 'Одобрена') {
        const fullPdfPath = resolveUploadPath(molba.arhivaPdfPath);
        sendMolbaApprovedEmail(molba.student.email, studentFullName, molba.naslov, fullPdfPath).catch(err => {
          console.error('[Controller] Background approval email error:', err.message);
        });
      } else if (molba.status === 'Одбиена') {
        sendMolbaRejectedEmail(molba.student.email, studentFullName, molba.naslov, molba.feedback || '').catch(err => {
          console.error('[Controller] Background rejection email error:', err.message);
        });
      }
    }

    req.flash('success', 'PDF документот е успешно генериран и пратен на студентот.');
    return res.redirect(`/dashboard/molba/${req.params.id}`);
  } catch (error) {
    console.error('Generate molba pdf error:', error);
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



