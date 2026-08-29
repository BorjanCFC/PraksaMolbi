const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const PDFDocument = require('pdfkit');

const {
  Molba,
  User,
  Student,
  Role,
  UserRole
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


/* =========================================================
   CONSTANTS
========================================================= */

const allowedStatuses = new Set([
  'Во процес',
  'Одобрена',
  'Одбиена'
]);

const allowedSemestri = new Set([
  'Зимски',
  'Летен'
]);


const FEIT_MAJOR_OPTIONS = [
  'ЕАОИЕ',
  'ЕЕПМ',
  'ЕЕС',
  'КСИАР',
  'КТИ',
  'КХИЕ',
  'ТКИИ'
];

const FEIT_MAJOR_SET =
  new Set(
    FEIT_MAJOR_OPTIONS
  );

const academicYearPattern = /^\d{4}\/\d{4}$/;


const WORKFLOW_STAGE = {
  SUBMITTED: 'SUBMITTED',
  ARCHIVED: 'ARCHIVED',
  SERVICE_REVIEWED: 'SERVICE_REVIEWED',
  DECIDED: 'DECIDED',
  COMPLETED: 'COMPLETED'
};

const WORKFLOW_STAGE_LABEL = {
  SUBMITTED: 'Поднесена - чека архивирање',
  ARCHIVED: 'Архивирана - чека проверка од Студентска служба',
  SERVICE_REVIEWED: 'Проверена од Студентска служба - чека одлука од Продекан',
  DECIDED: 'Одлуката е донесена - чека генерирање PDF',
  COMPLETED: 'Завршена'
};

const getResolvedWorkflowStage = (molba) => {
  if (
    molba.workflowStage &&
    WORKFLOW_STAGE_LABEL[molba.workflowStage]
  ) {
    return molba.workflowStage;
  }

  if (molba.arhivaPdfPath) {
    return WORKFLOW_STAGE.COMPLETED;
  }

  if (
    molba.status === 'Одобрена' ||
    molba.status === 'Одбиена'
  ) {
    return WORKFLOW_STAGE.DECIDED;
  }

  if (molba.arhivskiBroj) {
    return WORKFLOW_STAGE.ARCHIVED;
  }

  return WORKFLOW_STAGE.SUBMITTED;
};

const getWorkflowStageLabel = (molba) => {
  const stage = getResolvedWorkflowStage(
    molba
  );

  return (
    WORKFLOW_STAGE_LABEL[stage] ||
    stage
  );
};

const isWorkflowVisibleToRole = (
  role,
  molba
) => {
  const stage =
    getResolvedWorkflowStage(molba);

  /*
   * Global admin gleda se.
   */
  if (role === ROLE.ADMIN) {
    return true;
  }

  /*
   * Arhiva mora da ja vidi novata molba.
   * Isto taka ja zadrzhuvame istorijata.
   */
  if (role === ROLE.ARHIVA) {
    return true;
  }

  /*
   * Studentska sluzhba:
   *
   * - ne ja gleda SUBMITTED
   * - ja dobiva po arhiviranje
   * - po potvrda ja prakja kaj prodekan
   * - pak ja dobiva po odluka za PDF
   * - ja gleda i zavrshenata istorija
   */
  if (
    role ===
    ROLE.STUDENTSKA_SLUZHBA
  ) {
    return [
      WORKFLOW_STAGE.ARCHIVED,
      WORKFLOW_STAGE.DECIDED,
      WORKFLOW_STAGE.COMPLETED
    ].includes(stage);
  }

  /*
   * Prodekan:
   *
   * ne ja gleda dodeka Sluzhba
   * ne ja potvrdi proverката.
   */
  if (
    role ===
    ROLE.PRODEKAN
  ) {
    return [
      WORKFLOW_STAGE.SERVICE_REVIEWED,
      WORKFLOW_STAGE.DECIDED,
      WORKFLOW_STAGE.COMPLETED
    ].includes(stage);
  }

  return false;
};

const isWorkflowCompletedForRole = (
  role,
  molba
) => {
  const stage =
    getResolvedWorkflowStage(molba);

  /*
   * Student / Admin:
   * cel proces e zavrshen duri po PDF.
   */
  if (
    role === ROLE.ADMIN ||
    isStudentRole(role)
  ) {
    return (
      stage ===
      WORKFLOW_STAGE.COMPLETED
    );
  }

  /*
   * Arhiva:
   * nejzinata aktivna rabota zavrshuva
   * koga e vnesen arhivski broj.
   */
  if (
    role === ROLE.ARHIVA
  ) {
    return (
      stage !==
      WORKFLOW_STAGE.SUBMITTED
    );
  }

  /*
   * Studentska sluzhba:
   * finalno zavrshena po generiran PDF.
   */
  if (
    role ===
    ROLE.STUDENTSKA_SLUZHBA
  ) {
    return (
      stage ===
      WORKFLOW_STAGE.COMPLETED
    );
  }

  /*
   * Prodekan:
   * negovata aktivna rabota zavrshuva
   * koga ke ja donese odlukata.
   */
  if (
    role ===
    ROLE.PRODEKAN
  ) {
    return [
      WORKFLOW_STAGE.DECIDED,
      WORKFLOW_STAGE.COMPLETED
    ].includes(stage);
  }

  return false;
};

const runBackgroundEmail = (
  label,
  emailTask
) => {
  /*
   * Promise.resolve().then(...) e namerno.
   *
   * Na ovoj nachin:
   * - async SMTP error ne go rusi requestot
   * - ni synchronous throw od email funkcija
   *   ne ja rusi glavnata akcija
   */
  Promise.resolve()
    .then(emailTask)
    .then((result) => {
      if (result === false) {
        console.warn(
          `[Controller] ${label}: email ne e ispraten, `
          + 'no glavnata akcija e uspesna.'
        );
      }
    })
    .catch((error) => {
      console.error(
        `[Controller] ${label} email error:`,
        error.message
      );
    });
};


const projectRoot = path.join(__dirname, '..');


const molbaStudentInclude = [
  {
    model: User,
    as: 'student',
    include: [
      {
        model: Student,
        as: 'studentProfile'
      }
    ]
  }
];


/*
 * Се користи за staff dashboard.
 *
 * Доколку е внесен број на индекс,
 * филтрира преку students.brIndeks.
 *
 * Не користиме dropdown со сите студенти,
 * бидејќи системот може да има илјадници студенти.
 */
const buildMolbaStudentInclude = (studentIndex = '') => {
  const cleanStudentIndex = String(studentIndex || '').trim();

  const studentProfileInclude = {
    model: Student,
    as: 'studentProfile',
    required: Boolean(cleanStudentIndex)
  };

  if (cleanStudentIndex) {
    studentProfileInclude.where = {
      brIndeks: {
        [Op.iLike]: `%${cleanStudentIndex}%`
      }
    };
  }

  return [
    {
      model: User,
      as: 'student',
      required: true,
      include: [
        studentProfileInclude
      ]
    }
  ];
};


const assignableStaffRoles = new Set([
  ROLE.ADMIN,
  ROLE.STUDENTSKA_SLUZHBA,
  ROLE.PRODEKAN,
  ROLE.ARHIVA
]);


const roleTipByRole = {
  [ROLE.ADMIN]: 'Admin',

  [ROLE.STUDENTSKA_SLUZHBA]:
    'Sluzhba',

  [ROLE.PRODEKAN]:
    'Prodekan',

  [ROLE.ARHIVA]:
    'Arhiva'
};


const newestFirstOrder = [
  ['createdAt', 'DESC'],
  ['molbaId', 'DESC']
];


/* =========================================================
   GENERAL HELPERS
========================================================= */

const toPosixPath = (value) => {
  return value.replace(/\\/g, '/');
};


const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(
      dirPath,
      {
        recursive: true
      }
    );
  }
};


const findFileInUploadsByName = (fileName) => {
  const uploadsRoot = path.join(
    projectRoot,
    'uploads'
  );

  const search = (dirPath) => {
    if (!fs.existsSync(dirPath)) {
      return null;
    }

    const entries = fs.readdirSync(
      dirPath,
      {
        withFileTypes: true
      }
    );

    for (const entry of entries) {
      const fullPath = path.join(
        dirPath,
        entry.name
      );

      if (
        entry.isFile() &&
        entry.name === fileName
      ) {
        return fullPath;
      }

      if (entry.isDirectory()) {
        const nested = search(fullPath);

        if (nested) {
          return nested;
        }
      }
    }

    return null;
  };

  return search(uploadsRoot);
};


/* =========================================================
   PDF FONTS
========================================================= */

const getCyrillicFonts = () => {
  const candidates = [
    /*
     * Windows - local development
     */
    {
      regular:
        'C:/Windows/Fonts/times.ttf',

      bold:
        'C:/Windows/Fonts/timesbd.ttf'
    },

    {
      regular:
        'C:/Windows/Fonts/arial.ttf',

      bold:
        'C:/Windows/Fonts/arialbd.ttf'
    },

    {
      regular:
        'C:/Windows/Fonts/segoeui.ttf',

      bold:
        'C:/Windows/Fonts/segoeuib.ttf'
    },

    /*
     * Linux - production server
     */
    {
      regular:
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',

      bold:
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
    }
  ];

  const fontSet = candidates.find(
    (item) => {
      return (
        fs.existsSync(item.regular) &&
        fs.existsSync(item.bold)
      );
    }
  );

  if (!fontSet) {
    throw new Error(
      'Не е пронајден font со поддршка за кирилица.'
    );
  }

  return fontSet;
};


const formatDateMk = (value) => {
  if (!value) {
    return '-';
  }

  if (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    const [
      year,
      month,
      day
    ] = value.split('-');

    return `${day}.${month}.${year}`;
  }

  const date = new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return String(value);
  }

  const day = String(
    date.getDate()
  ).padStart(2, '0');

  const month = String(
    date.getMonth() + 1
  ).padStart(2, '0');

  const year =
    date.getFullYear();

  return `${day}.${month}.${year}`;
};


const sanitizePdfText = (value) => {
  if (
    value === null ||
    value === undefined
  ) {
    return '';
  }

  return String(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD\u25A1]/g,
      ''
    )
    .trim();
};


/* =========================================================
   PDF GENERATION
========================================================= */

const generateArchivePdfFile = async (molba) => {
  const nasoka =
    molba.student.smer ||
    (
      molba.student.studentProfile
        ? molba.student.studentProfile.smer
        : null
    ) ||
    'unknown';

  const relArchivePath =
    getArchivePath(
      nasoka,
      molba.student.ime,
      molba.student.prezime
    );

  const specificArchiveDir =
    path.join(
      projectRoot,
      'uploads',
      relArchivePath
    );

  ensureDir(
    specificArchiveDir
  );

  const safeIme = String(molba.student.ime || '')
  .trim()
  .replace(/\s+/g, '')
  .replace(/[^\p{L}\p{N}]/gu, '');

  const safePrezime = String(molba.student.prezime || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');

  const fileName =
    `Molba-${molba.molbaId}-${safeIme}${safePrezime}.pdf`;

  const fullPath =
    path.join(
      specificArchiveDir,
      fileName
    );

  const relativePath =
    toPosixPath(
      path.join(
        relArchivePath,
        fileName
      )
    );

  const studentProfile =
    molba.student &&
    molba.student.studentProfile
      ? molba.student.studentProfile
      : null;

  const studentName =
    `${
      convertNameToCyrillic(
        molba.student.ime
      )
    } ${
      convertNameToCyrillic(
        molba.student.prezime
      )
    }`.trim();

  const indexValue =
    molba.student.brIndeks ||
    (
      studentProfile
        ? studentProfile.brIndeks
        : null
    ) ||
    '-';

  const majorValue =
    molba.student.smer ||
    (
      studentProfile
        ? studentProfile.smer
        : null
    ) ||
    '-';

  const titleValue =
    sanitizePdfText(
      molba.naslov
    ) ||
    'Без наслов';

  const archiveNumberValue =
    molba.arhivskiBroj ||
    '-';

  const semesterValue =
    molba.semestar ||
    '-';

  const academicYearValue =
    molba.ucebnaGodina ||
    '-';

  const submitDateValue =
    formatDateMk(
      molba.datum
    );

  const descriptionValue =
    sanitizePdfText(
      molba.description
    );

  const statusValue =
    molba.status ||
    'Во процес';

  const feedbackValue =
    sanitizePdfText(
      molba.feedback
    );

  const shouldRenderFeedback =
    statusValue === 'Одбиена' &&
    feedbackValue !== '';

  const studentLine = [
    studentName,
    indexValue,
    majorValue
  ]
    .filter(Boolean)
    .join(' ');


  await new Promise(
    (
      resolve,
      reject
    ) => {

      const doc =
        new PDFDocument({
          size: 'A4',

          margins: {
            top: 56,
            left: 56,
            right: 56,
            bottom: 56
          }
        });

      const stream =
        fs.createWriteStream(
          fullPath
        );

      stream.on(
        'finish',
        resolve
      );

      stream.on(
        'error',
        reject
      );

      doc.on(
        'error',
        reject
      );

      doc.pipe(stream);


      /* ===================================================
         CYRILLIC FONTS
      =================================================== */

      const cyrillicFonts =
        getCyrillicFonts();

      doc.registerFont(
        'pdf-regular',
        cyrillicFonts.regular
      );

      doc.registerFont(
        'pdf-bold',
        cyrillicFonts.bold
      );

      const regularFont =
        'pdf-regular';

      const boldFont =
        'pdf-bold';


      /* ===================================================
         LOGOS
      =================================================== */

      const ukimLogoPath =
        path.join(
          projectRoot,
          'public',
          'images',
          'ukim-logo.png'
        );

      const feitRightLogoPath =
        path.join(
          projectRoot,
          'public',
          'images',
          'feitLogoBrowser.png'
        );


      if (
        fs.existsSync(
          ukimLogoPath
        )
      ) {
        doc.image(
          ukimLogoPath,
          52,
          52,
          {
            fit: [68, 68],
            align: 'left',
            valign: 'top'
          }
        );
      }


      if (
        fs.existsSync(
          feitRightLogoPath
        )
      ) {
        doc.image(
          feitRightLogoPath,
          492,
          52,
          {
            fit: [64, 64],
            align: 'right',
            valign: 'top'
          }
        );
      }


      doc.fillColor(
        '#000000'
      );


      const headerX = 108;
      const headerWidth = 380;


      doc
          .font(boldFont)
          .fontSize(14)
          .text(
            'Универзитет "Св. Кирил и Методиј" во Скопје',
            headerX,
            68,
            {
              width:
                headerWidth,

              align:
                'center',

              lineBreak:
                false
            }
          );


      doc
        .font(boldFont)
        .fontSize(14)
        .text(
          'ФАКУЛТЕТ ЗА ЕЛЕКТРОТЕХНИКА И',
          headerX,
          110,
          {
            width:
              headerWidth,

            align:
              'center'
          }
        );


      doc
        .font(boldFont)
        .fontSize(14)
        .text(
          'ИНФОРМАЦИСКИ ТЕХНОЛОГИИ',
          headerX,
          132,
          {
            width:
              headerWidth,

            align:
              'center'
          }
        );


      doc
        .font(boldFont)
        .fontSize(13)
        .text(
          'Датум:',
          72,
          190,
          {
            continued: true
          }
        );


      doc
        .font(regularFont)
        .fontSize(13)
        .text(
          ` ${submitDateValue}`
        );


      doc
        .font(boldFont)
        .fontSize(13)
        .text(
          'Архивски број:',
          350,
          190,
          {
            continued: true
          }
        );


      doc
        .font(regularFont)
        .fontSize(13)
        .text(
          ` ${archiveNumberValue}`
        );


      doc
        .font(boldFont)
        .fontSize(18)
        .text(
          'Молба',
          0,
          245,
          {
            align: 'center'
          }
        );


      let y = 315;

      const leftX = 72;
      const contentWidth = 450;
      const labelFontSize = 14;
      const valueFontSize = 14;


      doc
        .font(boldFont)
        .fontSize(
          labelFontSize
        )
        .text(
          'Наслов на молбата:',
          leftX,
          y,
          {
            continued: true
          }
        );


      doc
        .font(regularFont)
        .fontSize(
          valueFontSize
        )
        .text(
          ` ${titleValue}`,
          {
            width:
              contentWidth,

            lineGap:
              3
          }
        );


      y =
        doc.y + 14;


      doc
        .font(boldFont)
        .fontSize(
          labelFontSize
        )
        .text(
          'Студент:',
          leftX,
          y,
          {
            continued: true
          }
        );


      doc
        .font(regularFont)
        .fontSize(
          valueFontSize
        )
        .text(
          ` ${studentLine}`,
          {
            width:
              contentWidth,

            lineGap:
              3
          }
        );


      y =
        doc.y + 14;


      doc
        .font(boldFont)
        .fontSize(
          labelFontSize
        )
        .text(
          'Семестар и учебна година:',
          leftX,
          y,
          {
            continued: true
          }
        );


      doc
        .font(regularFont)
        .fontSize(
          valueFontSize
        )
        .text(
          ` ${semesterValue} ${academicYearValue}`,
          {
            width:
              contentWidth,

            lineGap:
              3
          }
        );


      y =
        doc.y + 18;


      doc
        .font(boldFont)
        .fontSize(
          labelFontSize
        )
        .text(
          'Опис на молбата:',
          leftX,
          y,
          {
            continued: true
          }
        );


      doc
        .font(regularFont)
        .fontSize(
          valueFontSize
        )
        .text(
          ` ${
            descriptionValue ||
            '-'
          }`,
          {
            width:
              contentWidth,

            lineGap:
              4
          }
        );


      const footerY =
        doc.y + 35;


      doc
        .font(boldFont)
        .fontSize(
          labelFontSize
        )
        .text(
          'Статус:',
          leftX,
          footerY,
          {
            continued: true
          }
        );


      doc
        .font(regularFont)
        .fontSize(
          valueFontSize
        )
        .text(
          ` ${statusValue}`
        );


      if (
        shouldRenderFeedback
      ) {
        doc
          .font(boldFont)
          .fontSize(17)
          .text(
            'Повратна информација:',
            72,
            footerY + 36,
            {
              continued: true
            }
          );

        doc
          .font(regularFont)
          .fontSize(17)
          .text(
            ` ${feedbackValue}`,
            {
              width: 450,
              lineGap: 3
            }
          );
      }


      doc.end();
    }
  );


  return relativePath;
};


/* =========================================================
   SESSION / AUTH HELPERS
========================================================= */

const getSessionUser = (req) => {
  return (
    req.session &&
    req.session.user
      ? req.session.user
      : null
  );
};


const requireAuth = (
  req,
  res
) => {
  const user =
    getSessionUser(req);

  if (user) {
    return user;
  }

  req.flash(
    'error',
    'Ве молиме најавете се.'
  );

  res.redirect('/login');

  return null;
};


const requireStudent = (
  req,
  res
) => {
  const user =
    requireAuth(
      req,
      res
    );

  if (!user) {
    return null;
  }

  if (
    isStudentRole(
      user.role
    )
  ) {
    return user;
  }

  req.flash(
    'error',
    'Оваа страница е достапна само за студенти.'
  );

  res.redirect(
    '/dashboard'
  );

  return null;
};


const requireStaff = (
  req,
  res
) => {
  const user =
    requireAuth(
      req,
      res
    );

  if (!user) {
    return null;
  }

  if (
    isStaffRole(
      user.role
    )
  ) {
    return user;
  }

  req.flash(
    'error',
    'Немате дозвола за оваа акција.'
  );

  res.redirect(
    '/dashboard'
  );

  return null;
};


/* =========================================================
   FILE HELPERS
========================================================= */

const resolveUploadPath = (
  relativePath
) => {
  if (!relativePath) {
    return null;
  }

  const normalized =
    path.normalize(
      relativePath
    );

  const candidates = [];


  if (
    path.isAbsolute(
      normalized
    )
  ) {
    candidates.push(
      normalized
    );
  } else {
    if (
      normalized.startsWith(
        `uploads${path.sep}`
      )
    ) {
      candidates.push(
        path.join(
          projectRoot,
          normalized
        )
      );
    } else {
      candidates.push(
        path.join(
          projectRoot,
          'uploads',
          normalized
        ),

        path.join(
          projectRoot,
          normalized
        )
      );
    }
  }


  for (
    const candidatePath
    of candidates
  ) {
    if (
      fs.existsSync(
        candidatePath
      )
    ) {
      return candidatePath;
    }
  }


  const fallbackFileName =
    path.basename(
      normalized
    );

  return findFileInUploadsByName(
    fallbackFileName
  );
};


/* =========================================================
   FILTER HELPERS
========================================================= */

const addDateFilter = (
  whereClause,
  fromDate,
  toDate
) => {
  if (
    fromDate &&
    toDate
  ) {
    whereClause.datum = {
      [Op.between]: [
        fromDate,
        toDate
      ]
    };

    return;
  }

  if (fromDate) {
    whereClause.datum = {
      [Op.gte]:
        fromDate
    };

    return;
  }

  if (toDate) {
    whereClause.datum = {
      [Op.lte]:
        toDate
    };
  }
};


const requiresArchiveNumberBeforeReview =
  (role) => {
    return (
      role ===
        ROLE.STUDENTSKA_SLUZHBA ||

      role ===
        ROLE.PRODEKAN
    );
  };


/* =========================================================
   USER / ROLE HELPERS
========================================================= */

const normalizeEmail = (
  value
) => {
  return String(
    value || ''
  )
    .trim()
    .toLowerCase();
};


const isValidEmail = (
  value
) => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    .test(value);
};


const isAllowedStaffEmailDomain =
  (email) => {
    const raw =
      process.env
        .FEIT_STAFF_ALLOWED_EMAIL_DOMAINS ||
      'feit.ukim.edu.mk';

    const allowedDomains =
      raw
        .split(',')
        .map(
          (value) =>
            value
              .trim()
              .toLowerCase()
        )
        .filter(Boolean);

    const domain =
      (
        email.split('@')[1] ||
        ''
      ).toLowerCase();

    return allowedDomains.includes(
      domain
    );
  };


const toNamePart = (
  value,
  fallback
) => {
  const clean =
    String(
      value || ''
    ).trim();

  if (!clean) {
    return fallback;
  }

  return (
    clean.charAt(0).toUpperCase() +
    clean.slice(1)
  );
};


const deriveNameFromEmail = (
  email
) => {
  const localPart =
    (
      email.split('@')[0] ||
      ''
    ).trim();

  const parts =
    localPart
      .split(/[._-]+/)
      .filter(Boolean);

  return {
    ime:
      toNamePart(
        parts[0],
        'Корисник'
      ),

    prezime:
      toNamePart(
        parts
          .slice(1)
          .join(' '),

        'Профил'
      )
  };
};


/* =========================================================
   STUDENT DATA HELPER
========================================================= */

const prepareStudentData = (
  items
) => {
  items.forEach(
    (item) => {
      if (!item.student) {
        return;
      }

      item.student.setDataValue(
        'brIndeks',

        item.student.studentProfile
          ? item.student
              .studentProfile
              .brIndeks
          : null
      );

      item.student.setDataValue(
        'smer',

        item.student.studentProfile
          ? item.student
              .studentProfile
              .smer
          : null
      );
    }
  );
};


/* =========================================================
   GET /dashboard
========================================================= */

exports.getDashboard = async (
  req,
  res
) => {

  const user =
    requireAuth(
      req,
      res
    );


  if (!user) {
    return;
  }


  try {

    const {
      status,
      semestar,
      ucebnaGodina,
      studentIndex,
      fromDate,
      toDate
    } = req.query;


    const hasActiveFilters =
      Boolean(
        (
          status &&
          status !== 'site'
        ) ||

        (
          semestar &&
          semestar !== 'site'
        ) ||

        (
          ucebnaGodina &&
          ucebnaGodina !== 'site'
        ) ||

        String(
          studentIndex || ''
        ).trim() ||

        fromDate ||

        toDate
      );


    /* =====================================================
       STUDENT DASHBOARD
    ===================================================== */

    if (
      isStudentRole(
        user.role
      )
    ) {

      const student =
        await User.findByPk(
          user.userId,
          {
            include: [
              {
                model:
                  Student,

                as:
                  'studentProfile'
              }
            ]
          }
        );


      if (
        student &&
        student.studentProfile
      ) {

        user.brIndeks =
          student
            .studentProfile
            .brIndeks ||
          null;


        user.smer =
          student
            .studentProfile
            .smer ||
          null;


        if (
          req.session &&
          req.session.user
        ) {

          req.session
            .user
            .brIndeks =
            user.brIndeks;


          req.session
            .user
            .smer =
            user.smer;
        }
      }


      const where = {
        userId:
          user.userId
      };


      if (
        status &&
        status !== 'site' &&
        allowedStatuses.has(
          status
        )
      ) {
        where.status =
          status;
      }


      if (
        semestar &&
        semestar !== 'site' &&
        allowedSemestri.has(
          semestar
        )
      ) {
        where.semestar =
          semestar;
      }


      if (
        ucebnaGodina &&
        ucebnaGodina !== 'site' &&
        academicYearPattern.test(
          ucebnaGodina
        )
      ) {
        where.ucebnaGodina =
          ucebnaGodina;
      }


      addDateFilter(
        where,
        fromDate,
        toDate
      );


      const molbi =
        await Molba.findAll({
          where,

          order:
            newestFirstOrder
        });


      const siteMolbi =
        await Molba.findAll({
          where: {
            userId:
              user.userId
          },

          order:
            newestFirstOrder
        });


      /*
       * Kaj student:
       * active = Vo proces
       * completed = Odobrena / Odbiena
       */
      const activeMolbi =
        molbi.filter(
          (item) =>
            item.status ===
            'Во процес'
        );


      const completedMolbi =
        molbi.filter(
          (item) =>
            item.status ===
              'Одобрена' ||

            item.status ===
              'Одбиена'
        );


      const academicYearOptions =
        [
          ...new Set(
            siteMolbi
              .map(
                (item) =>
                  item.ucebnaGodina
              )
              .filter(
                Boolean
              )
          )
        ]
          .sort(
            (a, b) =>
              b.localeCompare(a)
          );


      return res.render(
        'dashboard',
        {
          title:
            'Dashboard',

          viewer:
            user,

          getRoleLabel,

          convertNameToCyrillic,

          formatDateMk,

          isImpersonating:
            false,

          isStudent:
            true,

          canManage:
            false,

          student,

          molbi,

          activeMolbi,

          completedMolbi,

          siteMolbi,

          academicYearOptions,

          hasActiveFilters,

          currentStatus:
            status ||
            'site',

          currentSemestar:
            semestar ||
            'site',

          currentAcademicYear:
            ucebnaGodina ||
            'site',

          currentStudentIndex:
            '',

          currentFromDate:
            fromDate ||
            '',

          currentToDate:
            toDate ||
            '',

          success:
            req.flash(
              'success'
            ),

          error:
            req.flash(
              'error'
            )
        }
      );
    }


    /* =====================================================
       STAFF DASHBOARD
    ===================================================== */

    const where = {};


    if (
      status &&
      status !== 'site' &&
      allowedStatuses.has(
        status
      )
    ) {
      where.status =
        status;
    }


    if (
      semestar &&
      semestar !== 'site' &&
      allowedSemestri.has(
        semestar
      )
    ) {
      where.semestar =
        semestar;
    }


    if (
      ucebnaGodina &&
      ucebnaGodina !== 'site' &&
      academicYearPattern.test(
        ucebnaGodina
      )
    ) {
      where.ucebnaGodina =
        ucebnaGodina;
    }


    addDateFilter(
      where,
      fromDate,
      toDate
    );


    /*
     * Prvo se primenuvaat site standardni filtri.
     */
    const queried =
      await Molba.findAll({
        where,

        include:
          molbaStudentInclude,

        order:
          newestFirstOrder
      });


    prepareStudentData(
      queried
    );


    /*
     * Potoa se primenuva workflow visibility.
     */
    let visible =
      queried.filter(
        (item) =>
          isWorkflowVisibleToRole(
            user.role,
            item
          )
      );


    /* =====================================================
       TEXT INDEX FILTER
    ===================================================== */

    const searchIndex =
      String(
        studentIndex || ''
      )
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '');


    if (searchIndex) {

      visible =
        visible.filter(
          (item) => {

            /*
             * Student indexot fizicki e vo Student profile.
             * prepareStudentData moze da go postavi i na
             * item.student, no ne zavisime samo od toa.
             */
            const profileIndex =
              item &&
              item.student &&
              item.student.studentProfile
                ? item.student
                    .studentProfile
                    .brIndeks
                : null;


            const preparedIndex =
              item &&
              item.student
                ? (
                    typeof item.student.get ===
                    'function'
                      ? item.student.get(
                          'brIndeks'
                        )
                      : item.student.brIndeks
                  )
                : null;


            const indexValue =
              String(
                profileIndex ||
                preparedIndex ||
                ''
              )
                .trim()
                .toLowerCase()
                .replace(/\s+/g, '');


            /*
             * Text search:
             *
             * 106      -> 106/2022
             * 2022     -> 106/2022
             * 106/2022 -> 106/2022
             */
            return indexValue.includes(
              searchIndex
            );
          }
        );
    }


    const allRaw =
      await Molba.findAll({
        include:
          molbaStudentInclude,

        order:
          newestFirstOrder
      });


    prepareStudentData(
      allRaw
    );


    const allRole =
      allRaw.filter(
        (item) =>
          isWorkflowVisibleToRole(
            user.role,
            item
          )
      );


    /*
     * Site filtri se veke primeneti vrz visible,
     * pa vazhat i za aktivni i za zavrsheni.
     */
    const activeMolbi =
      visible.filter(
        (item) =>
          !isWorkflowCompletedForRole(
            user.role,
            item
          )
      );


    const completedMolbi =
      visible.filter(
        (item) =>
          isWorkflowCompletedForRole(
            user.role,
            item
          )
      );


    const academicYearOptions =
      [
        ...new Set(
          allRole
            .map(
              (item) =>
                item.ucebnaGodina
            )
            .filter(
              Boolean
            )
        )
      ]
        .sort(
          (a, b) =>
            b.localeCompare(a)
        );


    return res.render(
      'dashboard',
      {
        title:
          'Dashboard',

        viewer:
          user,

        getRoleLabel,

        convertNameToCyrillic,

        formatDateMk,

        isImpersonating:
          false,

        isStudent:
          false,

        isGlobalAdmin:
          user.role ===
          ROLE.ADMIN,

        canManage:
          false,

        molbi:
          visible,

        activeMolbi,

        completedMolbi,

        hasActiveFilters,

        stats: {

          vkupno:
            allRole.length,

          voProces:
            allRole.filter(
              (item) =>
                item.status ===
                'Во процес'
            ).length,

          odobreni:
            allRole.filter(
              (item) =>
                item.status ===
                'Одобрена'
            ).length,

          odbieni:
            allRole.filter(
              (item) =>
                item.status ===
                'Одбиена'
            ).length
        },

        academicYearOptions,

        currentStatus:
          status ||
          'site',

        currentSemestar:
          semestar ||
          'site',

        currentAcademicYear:
          ucebnaGodina ||
          'site',

        currentStudentIndex:
          String(
            studentIndex ||
            ''
          ).trim(),

        currentFromDate:
          fromDate ||
          '',

        currentToDate:
          toDate ||
          '',

        success:
          req.flash(
            'success'
          ),

        error:
          req.flash(
            'error'
          )
      }
    );

  } catch (error) {

    console.error(
      'Dashboard error:',
      error
    );


    req.flash(
      'error',
      'Настана грешка при вчитување.'
    );


    return res.redirect(
      '/login'
    );
  }
};

/* =========================================================
   POST /dashboard/assign-role
========================================================= */

exports.assignRoleByEmail =
  async (req, res) => {
    const user =
      requireStaff(
        req,
        res
      );

    if (!user) {
      return;
    }


    if (
      user.role !==
      ROLE.ADMIN
    ) {
      req.flash(
        'error',
        'Само админ може да доделува улоги.'
      );

      return res.redirect(
        '/dashboard'
      );
    }


    try {
      const email =
        normalizeEmail(
          req.body.email
        );

      const role =
        String(
          req.body.role ||
          ''
        )
          .trim()
          .toLowerCase();

      const authServer =
        String(
          req.body.authServer ||
          'smail'
        )
          .trim()
          .toLowerCase();


      /* ===================================================
         VALIDATION
      =================================================== */

      if (
        ![
          'smail',
          'makedon'
        ].includes(
          authServer
        )
      ) {
        req.flash(
          'error',
          'Избран е невалиден mail server.'
        );

        return res.redirect(
          '/dashboard'
        );
      }


      if (
        !email ||
        !isValidEmail(
          email
        )
      ) {
        req.flash(
          'error',
          'Внесете валиден email.'
        );

        return res.redirect(
          '/dashboard'
        );
      }


      if (
        !isAllowedStaffEmailDomain(
          email
        )
      ) {
        req.flash(
          'error',
          'За административни улоги дозволени се само FEIT email адреси.'
        );

        return res.redirect(
          '/dashboard'
        );
      }


      if (
        !assignableStaffRoles.has(
          role
        )
      ) {
        req.flash(
          'error',
          'Избраната улога не е валидна за доделување.'
        );

        return res.redirect(
          '/dashboard'
        );
      }


      const roleTip =
        roleTipByRole[
          role
        ];


      const dbRole =
        await Role.findOne({
          where: {
            tip:
              roleTip
          }
        });


      if (!dbRole) {
        req.flash(
          'error',
          'Бараната улога не постои во базата.'
        );

        return res.redirect(
          '/dashboard'
        );
      }


      /* ===================================================
         TRANSACTION
      =================================================== */

      const result =
        await User.sequelize.transaction(
          async (
            transaction
          ) => {

            /*
             * Барање само по email.
             *
             * Provider не се користи при пребарување,
             * бидејќи истиот user може да биде
             * Microsoft студент + административна улога.
             */
            let targetUser =
              await User.findOne({
                where: {
                  email
                },

                transaction
              });


            /* =============================================
               EXISTING USER
            ============================================= */

            if (targetUser) {
              const existingAssignment =
                await UserRole.findOne({
                  where: {
                    userId:
                      targetUser.userId,

                    roleId:
                      dbRole.roleId
                  },

                  transaction
                });


              if (
                existingAssignment
              ) {
                return {
                  status:
                    'already-exists',

                  targetUser
                };
              }


              /*
               * Не го менуваме provider.
               *
               * Microsoft студент останува microsoft.
               *
               * Само authServer се користи за
               * административниот FEIT login.
               */
              if (
                targetUser.provider !==
                'local'
              ) {
                await targetUser.update(
                  {
                    authServer
                  },
                  {
                    transaction
                  }
                );
              }


              await UserRole.create(
                {
                  userId:
                    targetUser.userId,

                  roleId:
                    dbRole.roleId
                },
                {
                  transaction
                }
              );


              return {
                status:
                  'added',

                targetUser,

                createdUser:
                  false
              };
            }


            /* =============================================
               NEW STAFF USER
            ============================================= */

            const nameParts =
              deriveNameFromEmail(
                email
              );


            targetUser =
              await User.create(
                {
                  ime:
                    nameParts.ime,

                  prezime:
                    nameParts.prezime,

                  email,

                  password:
                    null,

                  provider:
                    'feit_pop3',

                  providerId:
                    null,

                  authServer
                },
                {
                  transaction
                }
              );


            await UserRole.create(
              {
                userId:
                  targetUser.userId,

                roleId:
                  dbRole.roleId
              },
              {
                transaction
              }
            );


            return {
              status:
                'added',

              targetUser,

              createdUser:
                true
            };
          }
        );


      if (
        result.status ===
        'already-exists'
      ) {
        req.flash(
          'error',
          `Корисникот ${email} веќе ја има доделено улогата „${getRoleLabel(role)}“.`
        );

        return res.redirect(
          '/dashboard'
        );
      }


      req.flash(
        'success',
        `Улогата „${getRoleLabel(role)}“ е успешно доделена на ${email}.`
      );


      return res.redirect(
        '/dashboard'
      );

    } catch (error) {
      console.error(
        'Assign role error:',
        error
      );


      if (
        error &&
        error.name ===
          'SequelizeUniqueConstraintError'
      ) {
        req.flash(
          'error',
          'Корисникот веќе ја има оваа улога.'
        );

        return res.redirect(
          '/dashboard'
        );
      }


      req.flash(
        'error',
        'Настана грешка при доделување улога.'
      );

      return res.redirect(
        '/dashboard'
      );
    }
  };



/* WORKFLOW V2: SERVICE REVIEW */

/*
 * POST /dashboard/molba/:id/service-review
 *
 * Studentska sluzhba:
 * - ja proveruva arhiviranata molba
 * - ostava optional feedback do Prodekan
 * - ja prakja vo SERVICE_REVIEWED
 */
exports.confirmServiceReview =
  async (
    req,
    res
  ) => {
    const user =
      requireStaff(
        req,
        res
      );

    if (!user) {
      return;
    }


    if (
      user.role !==
      ROLE.STUDENTSKA_SLUZHBA
    ) {
      req.flash(
        'error',
        'Само Студентската служба може да ја потврди проверката.'
      );

      return res.redirect(
        '/dashboard'
      );
    }


    try {
      const molba =
        await Molba.findByPk(
          req.params.id
        );


      if (!molba) {
        req.flash(
          'error',
          'Молбата не е пронајдена.'
        );

        return res.redirect(
          '/dashboard'
        );
      }


      const stage =
        getResolvedWorkflowStage(
          molba
        );


      if (
        stage !==
        WORKFLOW_STAGE.ARCHIVED
      ) {
        req.flash(
          'error',
          'Молбата не е во фаза за проверка од Студентската служба.'
        );

        return res.redirect(
          '/dashboard'
        );
      }


      if (
        !molba.arhivskiBroj
      ) {
        req.flash(
          'error',
          'Молбата мора прво да има архивски број.'
        );

        return res.redirect(
          '/dashboard'
        );
      }


      const cleanFeedback =
        String(
          req.body.sluzhbaFeedback ||
          ''
        ).trim();


      molba.sluzhbaFeedback =
        cleanFeedback ||
        null;


      molba.workflowStage =
        WORKFLOW_STAGE.SERVICE_REVIEWED;


      await molba.save();


      req.flash(
        'success',
        'Проверката е потврдена. Молбата е испратена до Продекан.'
      );


      return res.redirect(
        '/dashboard'
      );

    } catch (error) {
      console.error(
        'Service review error:',
        error
      );

      req.flash(
        'error',
        'Настана грешка при потврдување на проверката.'
      );

      return res.redirect(
        '/dashboard'
      );
    }
  };


/* =========================================================
   GET /dashboard/nova-molba
========================================================= */

exports.getNovaMolba =
  async (
    req,
    res
  ) => {

    const user =
      requireStudent(
        req,
        res
      );


    if (!user) {
      return;
    }


    try {

      const studentProfile =
        await Student.findOne({
          where: {
            userId:
              user.userId
          }
        });


      return res.render(
        'nova-molba',
        {
          title:
            'Нова молба',

          viewer:
            user,

          getRoleLabel,

          convertNameToCyrillic,

          isImpersonating:
            false,

          studentProfile,

          majorOptions:
            FEIT_MAJOR_OPTIONS,

          error:
            req.flash(
              'error'
            )
        }
      );

    } catch (error) {

      console.error(
        'Load nova molba error:',
        error
      );


      req.flash(
        'error',
        'Настана грешка при вчитување на формата.'
      );


      return res.redirect(
        '/dashboard'
      );
    }
  };

/* =========================================================
   POST /dashboard/nova-molba
========================================================= */

exports.postNovaMolba =
  async (
    req,
    res
  ) => {
    const user =
      requireStudent(
        req,
        res
      );

    if (!user) {
      return;
    }


    try {
      const {
        naslov,
        semestar,
        ucebnaGodina,
        description,
        brIndeks,
        smer
      } = req.body;


      if (
        !naslov ||
        naslov.trim() === ''
      ) {
        req.flash(
          'error',
          'Насловот е задолжителен.'
        );

        return res.redirect(
          '/dashboard/nova-molba'
        );
      }


      if (
        !semestar ||
        !allowedSemestri.has(
          semestar
        )
      ) {
        req.flash(
          'error',
          'Семестарот мора да биде Зимски или Летен.'
        );

        return res.redirect(
          '/dashboard/nova-molba'
        );
      }


      if (
        !ucebnaGodina ||
        !academicYearPattern.test(
          ucebnaGodina.trim()
        )
      ) {
        req.flash(
          'error',
          'Учебната година мора да биде во формат ГГГГ/ГГГГ (пример 2025/2026).'
        );

        return res.redirect(
          '/dashboard/nova-molba'
        );
      }


      const [
        startYear,
        endYear
      ] =
        ucebnaGodina
          .trim()
          .split('/')
          .map(Number);


      if (
        endYear !==
        startYear + 1
      ) {
        req.flash(
          'error',
          'Учебната година не е валидна.'
        );

        return res.redirect(
          '/dashboard/nova-molba'
        );
      }


      if (
        !brIndeks ||
        brIndeks.trim() === ''
      ) {
        req.flash(
          'error',
          'Бројот на индекс е задолжителен.'
        );

        return res.redirect(
          '/dashboard/nova-molba'
        );
      }


      if (!smer || !FEIT_MAJOR_SET.has(String(smer).trim())) {
        req.flash(
          'error',
          'Насоката е задолжителна.'
        );

        return res.redirect(
          '/dashboard/nova-molba'
        );
      }


      const cleanDescription =
        String(
          description ||
          ''
        ).trim();


      if (!cleanDescription) {
        req.flash(
          'error',
          'Текстот на молбата е задолжителен.'
        );

        return res.redirect(
          '/dashboard/nova-molba'
        );
      }


      if (!req.file) {
        req.flash(
          'error',
          'Прикачување PDF документ е задолжително.'
        );

        return res.redirect(
          '/dashboard/nova-molba'
        );
      }


      await Student.upsert({
        userId:
          user.userId,

        brIndeks:
          brIndeks.trim(),

        smer:
          smer.trim()
      });


      if (
        req.session &&
        req.session.user
      ) {
        req.session.user.brIndeks =
          brIndeks.trim();

        req.session.user.smer =
          smer.trim();
      }


      /*
       * GLAVNATA AKCIJA:
       * molbata se kreira nezavisno od email.
       */
      await Molba.create({
        userId:
          user.userId,

        naslov:
          naslov.trim(),

        semestar,

        ucebnaGodina:
          ucebnaGodina.trim(),

        description:
          cleanDescription,

        status:
          'Во процес',

        datum:
          new Date(),

        arhivskiBroj:
          null,

        workflowStage:
          WORKFLOW_STAGE.SUBMITTED,

        sluzhbaFeedback:
          null,

        prodekanFeedback:
          null,

        urlPath:
          toPosixPath(
            path.join(
              getStudentDocumentPath(
                smer.trim(),
                user.ime,
                user.prezime
              ),

              req.file.filename
            )
          )
      });


      /*
       * EMAIL E SECONDARY.
       *
       * Duri i SMTP / network da padne,
       * molbata ostanuva kreirana.
       */
      if (user.email) {
        const studentFullName =
          `${user.ime} ${user.prezime}`;

        runBackgroundEmail(
          'Molba created',
          () =>
            sendMolbaCreatedEmail(
              user.email,
              studentFullName,
              naslov.trim()
            )
        );
      }


      req.flash(
        'success',
        'Молбата е успешно поднесена.'
      );


      return res.redirect(
        '/dashboard'
      );

    } catch (error) {
      if (
        error &&
        error.name ===
        'SequelizeUniqueConstraintError'
      ) {
        req.flash(
          'error',
          'Бројот на индекс веќе постои.'
        );

        return res.redirect(
          '/dashboard/nova-molba'
        );
      }


      console.error(
        'Create molba error:',
        error
      );


      req.flash(
        'error',
        'Настана грешка при креирање на молбата.'
      );


      return res.redirect(
        '/dashboard/nova-molba'
      );
    }
  };

/* =========================================================
   GET /dashboard/molba/:id
========================================================= */

exports.getMolbaDetail =
  async (
    req,
    res
  ) => {
    const user =
      requireAuth(
        req,
        res
      );

    if (!user) {
      return;
    }


    try {
      const whereClause = {
        molbaId:
          req.params.id
      };


      if (
        isStudentRole(
          user.role
        )
      ) {
        whereClause.userId =
          user.userId;
      }


      const molba =
        await Molba.findOne({
          where:
            whereClause,

          include:
            molbaStudentInclude
        });


      if (!molba) {
        req.flash(
          'error',
          'Молбата не е пронајдена.'
        );

        return res.redirect(
          '/dashboard'
        );
      }


      /*
       * Studentot moze samo sopstvena molba.
       * Staff mora da ja ima dobieno vo svojata workflow faza.
       */
      if (
        !isStudentRole(
          user.role
        ) &&
        !isWorkflowVisibleToRole(
          user.role,
          molba
        )
      ) {
        req.flash(
          'error',
          'Оваа молба сè уште не е достапна за Вашата улога.'
        );

        return res.redirect(
          '/dashboard'
        );
      }


      if (molba.student) {
        molba.student.setDataValue(
          'brIndeks',

          molba.student
            .studentProfile
            ? molba.student
                .studentProfile
                .brIndeks
            : null
        );


        molba.student.setDataValue(
          'smer',

          molba.student
            .studentProfile
            ? molba.student
                .studentProfile
                .smer
            : null
        );
      }


      const stage =
        getResolvedWorkflowStage(
          molba
        );


      const canArchiveNumber = user.role === ROLE.ARHIVA;


      const canServiceReview =
        user.role ===
          ROLE.STUDENTSKA_SLUZHBA &&

        stage ===
          WORKFLOW_STAGE.ARCHIVED;


      const canProdekanDecide =
        user.role ===
          ROLE.PRODEKAN &&

        stage ===
          WORKFLOW_STAGE.SERVICE_REVIEWED;


      const canGenerateMolbaPdf =
        user.role ===
          ROLE.STUDENTSKA_SLUZHBA &&

        stage ===
          WORKFLOW_STAGE.DECIDED &&

        (
          molba.status ===
            'Одобрена' ||

          molba.status ===
            'Одбиена'
        );


      const showInternalFeedback =
        [
          ROLE.ADMIN,
          ROLE.STUDENTSKA_SLUZHBA,
          ROLE.PRODEKAN
        ].includes(
          user.role
        );


      return res.render(
        'molba-detail',
        {
          title:
            `Молба #${molba.molbaId}`,

          viewer:
            user,

          getRoleLabel,

          convertNameToCyrillic,
          formatDateMk,

          isImpersonating:
            false,

          isStudent:
            isStudentRole(
              user.role
            ),

          /*
           * Stariot generic processing form
           * se iskluchuva.
           *
           * Odluka sega nosi samo Prodekan
           * preku canProdekanDecide.
           */
          canManage:
            false,

          canArchiveNumber,

          canServiceReview,

          canProdekanDecide,

          canGenerateMolbaPdf,

          showInternalFeedback,

          workflowStageLabel:
            getWorkflowStageLabel(
              molba
            ),

          molba,

          success:
            req.flash(
              'success'
            ),

          error:
            req.flash(
              'error'
            )
        }
      );

    } catch (error) {
      console.error(
        'Molba detail error:',
        error
      );

      req.flash(
        'error',
        'Настана грешка.'
      );

      return res.redirect(
        '/dashboard'
      );
    }
  };

/* =========================================================
   POST /dashboard/molba/:id/generate-archive-pdf

   Legacy endpoint.
   Ja koristi istata finalna logika.
========================================================= */

exports.generateArchivePdf =
  async (
    req,
    res
  ) => {
    return exports.generateMolbaPdf(
      req,
      res
    );
  };

/* =========================================================
   POST /dashboard/molba/:id/generate-molba-pdf
========================================================= */

exports.generateMolbaPdf =
  async (
    req,
    res
  ) => {
    const user =
      requireStaff(
        req,
        res
      );

    if (!user) {
      return;
    }


    if (
      user.role !==
      ROLE.STUDENTSKA_SLUZHBA
    ) {
      req.flash(
        'error',
        'Само Студентската служба може да го генерира финалниот PDF.'
      );

      return res.redirect(
        '/dashboard'
      );
    }


    try {
      const molba =
        await Molba.findByPk(
          req.params.id,
          {
            include:
              molbaStudentInclude
          }
        );


      if (!molba) {
        req.flash(
          'error',
          'Молбата не е пронајдена.'
        );

        return res.redirect(
          '/dashboard'
        );
      }


      const stage =
        getResolvedWorkflowStage(
          molba
        );


      if (
        stage !==
        WORKFLOW_STAGE.DECIDED
      ) {
        req.flash(
          'error',
          'PDF може да се генерира само откако Продеканот ќе донесе одлука.'
        );

        return res.redirect(
          '/dashboard'
        );
      }


      if (
        molba.status !==
          'Одобрена' &&

        molba.status !==
          'Одбиена'
      ) {
        req.flash(
          'error',
          'Молбата нема конечна одлука.'
        );

        return res.redirect(
          '/dashboard'
        );
      }


      if (
        !molba.arhivskiBroj
      ) {
        req.flash(
          'error',
          'Молбата нема архивски број.'
        );

        return res.redirect(
          '/dashboard'
        );
      }


      /*
       * Ako postoi star PDF, go regenerirame.
       */
      if (
        molba.arhivaPdfPath
      ) {
        const oldPdfPath =
          resolveUploadPath(
            molba.arhivaPdfPath
          );

        try {
          if (
            oldPdfPath &&
            fs.existsSync(
              oldPdfPath
            )
          ) {
            fs.unlinkSync(
              oldPdfPath
            );
          }
        } catch (unlinkError) {
          console.warn(
            '[Controller] Old PDF delete warning:',
            unlinkError.message
          );
        }
      }


      if (molba.student) {
        molba.student.setDataValue(
          'brIndeks',

          molba.student
            .studentProfile
            ? molba.student
                .studentProfile
                .brIndeks
            : null
        );

        molba.student.setDataValue(
          'smer',

          molba.student
            .studentProfile
            ? molba.student
                .studentProfile
                .smer
            : null
        );
      }


      /*
       * GLAVNATA AKCIJA:
       * PDF + COMPLETED se zachuvuvaat
       * PRED emailot.
       */
      molba.arhivaPdfPath =
        await generateArchivePdfFile(
          molba
        );


      molba.workflowStage =
        WORKFLOW_STAGE.COMPLETED;


      await molba.save();


      /*
       * EMAIL E SECONDARY.
       *
       * Ako mail serverot padne,
       * PDF i COMPLETED ostanuvaat zachuvani.
       */
      if (
        molba.student &&
        molba.student.email
      ) {
        const studentFullName =
          `${molba.student.ime} ${molba.student.prezime}`;


        if (
          molba.status ===
          'Одобрена'
        ) {
          const fullPdfPath =
            resolveUploadPath(
              molba.arhivaPdfPath
            );


          runBackgroundEmail(
            'Approved molba',
            () =>
              sendMolbaApprovedEmail(
                molba.student.email,
                studentFullName,
                molba.naslov,
                fullPdfPath
              )
          );

        } else {
          runBackgroundEmail(
            'Rejected molba',
            () =>
              sendMolbaRejectedEmail(
                molba.student.email,
                studentFullName,
                molba.naslov,
                molba.feedback ||
                  ''
              )
          );
        }
      }


      req.flash(
        'success',
        'PDF документот е успешно генериран. E-mail известувањето е иницирано.'
      );


      return res.redirect(
        '/dashboard'
      );

    } catch (error) {
      console.error(
        'Generate molba pdf error:',
        error
      );


      req.flash(
        'error',
        'Настана грешка при генерирање на PDF документот.'
      );


      return res.redirect(
        '/dashboard'
      );
    }
  };

/* =========================================================
   POST /dashboard/molba/:id/status

   SAMO PRODEKAN
========================================================= */

exports.updateStatus =
  async (
    req,
    res
  ) => {
    const user =
      requireStaff(
        req,
        res
      );

    if (!user) {
      return;
    }


    if (
      user.role !==
      ROLE.PRODEKAN
    ) {
      req.flash(
        'error',
        'Само Продеканот може да одобри или одбие молба.'
      );

      return res.redirect(
        '/dashboard'
      );
    }


    try {
      const {
        status,
        feedback,
        prodekanFeedback
      } = req.body;


      /*
       * Konechna odluka:
       * nema "Vo proces" od ovoj moment.
       */
      if (
        ![
          'Одобрена',
          'Одбиена'
        ].includes(
          status
        )
      ) {
        req.flash(
          'error',
          'Изберете Одобрена или Одбиена.'
        );

        return res.redirect(
          `/dashboard/molba/${req.params.id}`
        );
      }


      const molba =
        await Molba.findByPk(
          req.params.id
        );


      if (!molba) {
        req.flash(
          'error',
          'Молбата не е пронајдена.'
        );

        return res.redirect(
          '/dashboard'
        );
      }


      const stage =
        getResolvedWorkflowStage(
          molba
        );


      if (
        stage !==
        WORKFLOW_STAGE.SERVICE_REVIEWED
      ) {
        req.flash(
          'error',
          'Молбата сè уште не е потврдена од Студентската служба.'
        );

        return res.redirect(
          '/dashboard'
        );
      }


      molba.status =
        status;


      /*
       * feedback:
       * se prikazhuva / prakja do studentot.
       */
      molba.feedback =
        String(
          feedback ||
          ''
        ).trim() ||
        null;


      /*
       * prodekanFeedback:
       * interno do Studentska sluzhba.
       */
      molba.prodekanFeedback =
        String(
          prodekanFeedback ||
          ''
        ).trim() ||
        null;


      molba.workflowStage =
        WORKFLOW_STAGE.DECIDED;


      await molba.save();


      req.flash(
        'success',
        'Одлуката е успешно зачувана и молбата е испратена до Студентската служба.'
      );


      return res.redirect(
        '/dashboard'
      );

    } catch (error) {
      console.error(
        'Update status error:',
        error
      );


      req.flash(
        'error',
        'Настана грешка при зачувување на одлуката.'
      );


      return res.redirect(
        '/dashboard'
      );
    }
  };

/* =========================================================
   GET /dashboard/molba/:id/document/archive
========================================================= */

exports.downloadArchivePdf =
  async (req, res) => {
    const user =
      requireAuth(
        req,
        res
      );

    if (!user) {
      return;
    }


    try {
      const whereClause = {
        molbaId:
          req.params.id
      };


      if (
        isStudentRole(
          user.role
        )
      ) {
        whereClause.userId =
          user.userId;
      }


      const molba =
        await Molba.findOne({
          where:
            whereClause
        });


      if (
        !molba ||
        !molba.arhivaPdfPath
      ) {
        req.flash(
          'error',
          'Генерираниот PDF не е пронајден.'
        );

        return res.redirect(
          `/dashboard/molba/${req.params.id}`
        );
      }


      const fullPath =
        resolveUploadPath(
          molba.arhivaPdfPath
        );


      if (
        !fullPath ||
        !fs.existsSync(
          fullPath
        )
      ) {
        req.flash(
          'error',
          'PDF документот физички не постои.'
        );

        return res.redirect(
          `/dashboard/molba/${req.params.id}`
        );
      }


      return res.download(
        fullPath,
        path.basename(
          fullPath
        )
      );

    } catch (error) {
      console.error(
        'Download archive pdf error:',
        error
      );


      req.flash(
        'error',
        'Настана грешка при симнување на PDF документот.'
      );


      return res.redirect(
        `/dashboard/molba/${req.params.id}`
      );
    }
  };


/* =========================================================
   POST /dashboard/molba/:id/archive-number
========================================================= */

exports.updateArchiveNumber =
  async (
    req,
    res
  ) => {

    const user =
      requireStaff(
        req,
        res
      );


    if (!user) {
      return;
    }


    if (
      user.role !==
      ROLE.ARHIVA
    ) {

      req.flash(
        'error',
        'Само Архива може да внесе или измени архивски број.'
      );


      return res.redirect(
        '/dashboard'
      );
    }


    try {

      const arhivskiBroj =
        String(
          req.body.arhivskiBroj ||
          ''
        ).trim();


      if (!arhivskiBroj) {

        req.flash(
          'error',
          'Архивскиот број е задолжителен.'
        );


        return res.redirect(
          `/dashboard/molba/${req.params.id}`
        );
      }


      const molba =
        await Molba.findByPk(
          req.params.id
        );


      if (!molba) {

        req.flash(
          'error',
          'Молбата не е пронајдена.'
        );


        return res.redirect(
          '/dashboard'
        );
      }


      const currentStage =
        getResolvedWorkflowStage(
          molba
        );


      const firstArchive =
        currentStage ===
        WORKFLOW_STAGE.SUBMITTED;


      /*
       * Brojot sekogas moze da se promeni.
       */
      molba.arhivskiBroj =
        arhivskiBroj;


      /*
       * Samo prvoto arhiviranje ja menuva
       * workflow fazata.
       *
       * Podocnezhna korekcija samo go menuva
       * arhivskiot broj.
       */
      if (firstArchive) {

        molba.workflowStage =
          WORKFLOW_STAGE.ARCHIVED;
      }


      await molba.save();


      req.flash(
        'success',

        firstArchive
          ? 'Архивскиот број е успешно зачуван.'
          : 'Архивскиот број е успешно изменет.'
      );


      /*
       * Po zacuvuvanje se vrakjame
       * na listata so molbi.
       */
      return res.redirect(
        '/dashboard'
      );

    } catch (error) {

      if (
        error &&
        error.name ===
          'SequelizeUniqueConstraintError'
      ) {

        req.flash(
          'error',
          'Архивскиот број мора да биде уникатен.'
        );


        return res.redirect(
          `/dashboard/molba/${req.params.id}`
        );
      }


      console.error(
        'Update archive number error:',
        error
      );


      req.flash(
        'error',
        'Настана грешка при зачувување на архивскиот број.'
      );


      return res.redirect(
        `/dashboard/molba/${req.params.id}`
      );
    }
  };

exports.downloadStudentDocument =
  async (req, res) => {
    const user =
      requireAuth(
        req,
        res
      );

    if (!user) {
      return;
    }


    try {
      const whereClause = {
        molbaId:
          req.params.id
      };


      if (
        isStudentRole(
          user.role
        )
      ) {
        whereClause.userId =
          user.userId;
      }


      const molba =
        await Molba.findOne({
          where:
            whereClause
        });


      if (
        !molba ||
        !molba.urlPath
      ) {
        req.flash(
          'error',
          'Документот не е пронајден.'
        );

        return res.redirect(
          '/dashboard'
        );
      }


      const fullPath =
        resolveUploadPath(
          molba.urlPath
        );


      if (
        !fullPath ||
        !fs.existsSync(
          fullPath
        )
      ) {
        req.flash(
          'error',
          'Документот физички не постои.'
        );

        return res.redirect(
          '/dashboard'
        );
      }


      return res.download(
        fullPath,
        path.basename(
          fullPath
        )
      );

    } catch (error) {
      console.error(
        'Download student document error:',
        error
      );


      req.flash(
        'error',
        'Настана грешка при симнување.'
      );


      return res.redirect(
        '/dashboard'
      );
    }
  };