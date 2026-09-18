const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
const allowedCiklusi = new Set(['Прв', 'Втор']);



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


const staffRoleValueByTip = Object.fromEntries(
  Object.entries(roleTipByRole).map(([value, tip]) => [tip, value])
);
const adminRoleOptions = Object.entries(roleTipByRole).map(([value, tip]) => ({
  value,
  label: getRoleLabel(value),
  tip
}));

// Admin-role forms must originate from a session that received a token.
const ensureAdminRoleCsrf = (req) => {
  if (!req.session.adminRoleCsrf) {
    req.session.adminRoleCsrf = crypto.randomBytes(32).toString('hex');
  }
  return req.session.adminRoleCsrf;
};
const validAdminRoleCsrf = (req) => {
  const stored = req.session && req.session.adminRoleCsrf;
  const supplied = req.body && req.body.csrfToken;
  if (typeof stored !== 'string' || typeof supplied !== 'string' ||
      !/^[0-9a-f]{64}$/.test(stored) || !/^[0-9a-f]{64}$/.test(supplied)) return false;
  return crypto.timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(supplied, 'hex'));
};
const isCurrentAdminAuthorized = async (userId) => {
  const role = await Role.findOne({ where: { tip: 'Admin' } });
  if (!role) return false;
  return !!(await UserRole.findOne({ where: { userId, roleId: role.roleId } }));
};

// MOLBI_ADMIN_NAMES_DETAIL_V1
// Existing users.ime and users.prezime: no migration or new columns.
// Convert Latin-script administrative names on save; keep Cyrillic unchanged.
const normalizeStaffName = (value) => {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  return /[A-Za-z]/.test(normalized)
    ? convertNameToCyrillic(normalized)
    : normalized;
};
const validStaffName = (value) => value.length <= 100 &&
  /^[\p{L}\p{M}][\p{L}\p{M} .’'\-]*$/u.test(value);
const validStaffNamePair = (ime, prezime) =>
  !!ime && !!prezime && validStaffName(ime) && validStaffName(prezime);

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


// MOLBI_DECISION_PROOF_ONE_PAGE_V1
// Format the persisted instant in Macedonian local time (including DST).
const formatDecisionMoment = (value) => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw new Error('Недостига валиден датум и час на одлуката.');
  }
  const pieces = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Skopje',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const p = Object.fromEntries(pieces.map((item) => [item.type, item.value]));
  return { date: `${p.day}.${p.month}.${p.year}`, time: `${p.hour}:${p.minute}` };
};

/* =========================================================
   PDF GENERATION
========================================================= */


const getPdfProdekanIdentity = async () => {
  try {
    const prodekanRole = await Role.findOne({
      where: {
        tip: 'Prodekan'
      }
    });

    if (!prodekanRole) {
      return {
        ime: '',
        prezime: ''
      };
    }

    const assignment = await UserRole.findOne({
      where: {
        roleId: prodekanRole.roleId
      },
      order: [
        ['userId', 'ASC']
      ]
    });

    if (!assignment) {
      return {
        ime: '',
        prezime: ''
      };
    }

    const prodekanUser = await User.findByPk(
      assignment.userId
    );

    if (!prodekanUser) {
      return {
        ime: '',
        prezime: ''
      };
    }

    return {
      ime: convertNameToCyrillic(
        prodekanUser.ime || ''
      ).trim(),

      prezime: convertNameToCyrillic(
        prodekanUser.prezime || ''
      ).trim()
    };
  } catch (error) {
    console.error(
      'PDF Prodekan lookup error:',
      error
    );

    return {
      ime: '',
      prezime: ''
    };
  }
};


const parsePdfCsvLine = (line) => {
  const values = [];
  let value = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (
        quoted &&
        line[i + 1] === '"'
      ) {
        value += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }

      continue;
    }

    if (
      char === ',' &&
      !quoted
    ) {
      values.push(value);
      value = '';
      continue;
    }

    value += char;
  }

  values.push(value);

  return values;
};


const getDecisionTimestampFromAuditCsv = (
  molba
) => {
  try {
    const auditPath =
      path.join(
        projectRoot,
        'logs',
        'audit.csv'
      );

    if (
      !fs.existsSync(
        auditPath
      )
    ) {
      return null;
    }

    const csv =
      fs.readFileSync(
        auditPath,
        'utf8'
      );

    const lines =
      csv
        .split(/\r?\n/)
        .filter(Boolean);

    if (
      lines.length < 2
    ) {
      return null;
    }

    const header =
      parsePdfCsvLine(
        lines[0]
      );

    const timestampIndex =
      header.indexOf(
        'timestamp'
      );

    const roleIndex =
      header.indexOf(
        'role'
      );

    const methodIndex =
      header.indexOf(
        'method'
      );

    const pathIndex =
      header.indexOf(
        'path'
      );

    if (
      timestampIndex === -1 ||
      methodIndex === -1 ||
      pathIndex === -1
    ) {
      return null;
    }

    const expectedPath =
      `/dashboard/molba/${molba.molbaId}/status`;

    let latestTimestamp =
      null;

    for (
      let i = 1;
      i < lines.length;
      i += 1
    ) {
      const row =
        parsePdfCsvLine(
          lines[i]
        );

      const timestamp =
        String(
          row[timestampIndex] || ''
        ).trim();

      const role =
        roleIndex === -1
          ? ''
          : String(
              row[roleIndex] || ''
            )
              .trim()
              .toLowerCase();

      const method =
        String(
          row[methodIndex] || ''
        )
          .trim()
          .toUpperCase();

      const loggedPath =
        String(
          row[pathIndex] || ''
        ).trim();

      if (
        method !== 'POST' ||
        loggedPath !== expectedPath
      ) {
        continue;
      }

      if (
        role &&
        role !== 'prodekan' &&
        role !== 'продекан'
      ) {
        continue;
      }

      const parsed =
        new Date(
          timestamp
        );

      if (
        Number.isNaN(
          parsed.getTime()
        )
      ) {
        continue;
      }

      if (
        !latestTimestamp ||
        parsed > latestTimestamp
      ) {
        latestTimestamp =
          parsed;
      }
    }

    return latestTimestamp;
  } catch (error) {
    console.error(
      'PDF audit timestamp lookup error:',
      error
    );

    return null;
  }
};


const formatDecisionDateTimeMk = (
  value
) => {
  if (!value) {
    return {
      date: '-',
      time: '-'
    };
  }

  const date =
    value instanceof Date
      ? value
      : new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return {
      date: '-',
      time: '-'
    };
  }

  const parts =
    new Intl.DateTimeFormat(
      'en-GB',
      {
        timeZone:
          'Europe/Skopje',
        day:
          '2-digit',
        month:
          '2-digit',
        year:
          'numeric',
        hour:
          '2-digit',
        minute:
          '2-digit',
        hour12:
          false
      }
    ).formatToParts(
      date
    );

  const getPart =
    (type) =>
      parts.find(
        (part) =>
          part.type === type
      )?.value || '';

  return {
    date:
      `${getPart('day')}.${getPart('month')}.${getPart('year')}`,

    time:
      `${getPart('hour')}:${getPart('minute')}h`
  };
};


const generateArchivePdfFile = async (
  molba
) => {
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

  const safeIme =
    String(
      molba.student.ime || ''
    )
      .trim()
      .replace(
        /\s+/g,
        ''
      )
      .replace(
        /[^\p{L}\p{N}]/gu,
        ''
      );

  const safePrezime =
    String(
      molba.student.prezime || ''
    )
      .trim()
      .replace(
        /\s+/g,
        ''
      )
      .replace(
        /[^\p{L}\p{N}]/gu,
        ''
      );

  const fileName =
    `Molbi-${molba.molbaId}-${safeIme}${safePrezime}.pdf`;

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
    `${convertNameToCyrillic(molba.student.ime || '')} ${convertNameToCyrillic(molba.student.prezime || '')}`.trim();

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

  const studentLine =
    [
      studentName,
      indexValue,
      majorValue
    ]
      .filter(Boolean)
      .join(' ');

  const prodekanIdentity =
    await getPdfProdekanIdentity();

  /*
   * For the generated PDF use the timestamp of the
   * actual POST /status action from audit.csv first.
   * decisionAt is kept as a DB fallback for older
   * records or when the audit row is unavailable.
   */
  let decisionTimestamp =
    getDecisionTimestampFromAuditCsv(
      molba
    );

  if (
    !decisionTimestamp
  ) {
    decisionTimestamp =
      molba.decisionAt
        ? new Date(
            molba.decisionAt
          )
        : null;
  }

  const decisionDateTime =
    formatDecisionDateTimeMk(
      decisionTimestamp
    );

  const prodekanFullName =
    [
      prodekanIdentity.ime,
      prodekanIdentity.prezime
    ]
      .filter(Boolean)
      .join(' ')
      .trim() ||
    'Продекан';

  const confirmationText =
    `Овој документ е дигитално потврден од продеканот за настава на Факултетот за електротехника и информациски технологии, проф. д-р ${prodekanFullName} на ${decisionDateTime.date} во ${decisionDateTime.time}.`;

  const BASE_BODY_FONT_SIZE = 14;
  const MIN_BODY_FONT_SIZE = 11;
  const BODY_FONT_STEP = 0.25;
  const CONFIRMATION_FONT_SIZE = 9.3;

  const margins = {
    top: 56,
    left: 56,
    right: 56,
    bottom: 56
  };

  const leftX = 72;
  const contentWidth = 450;
  const bodyStartY = 283;

  const buildPdf = async (
    bodyFontSize,
    includeConfirmation,
    multiPageMode
  ) => {
    let pageCount = 1;
    const chunks = [];

    await new Promise(
      (resolve, reject) => {
        const doc =
          new PDFDocument({
            size: 'A4',
            margins
          });

        doc.on(
          'pageAdded',
          () => {
            pageCount += 1;
          }
        );

        doc.on(
          'data',
          (chunk) => {
            chunks.push(chunk);
          }
        );

        doc.on(
          'error',
          reject
        );

        doc.on(
          'end',
          resolve
        );

        try {
          const fontCandidates = [
            {
              regular:
                'C:/Windows/Fonts/times.ttf',
              bold:
                'C:/Windows/Fonts/timesbd.ttf'
            },
            {
              regular:
                '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
              bold:
                '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
            },
            {
              regular:
                '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
              bold:
                '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf'
            }
          ];

          const cyrillicFonts =
            fontCandidates.find(
              (fontSet) =>
                fs.existsSync(
                  fontSet.regular
                ) &&
                fs.existsSync(
                  fontSet.bold
                )
            );

          if (!cyrillicFonts) {
            throw new Error(
              'Nema dostapen Cyrillic PDF font na sistemot.'
            );
          }

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
                fit: [
                  68,
                  68
                ],
                align:
                  'left',
                valign:
                  'top'
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
                fit: [
                  64,
                  64
                ],
                align:
                  'right',
                valign:
                  'top'
              }
            );
          }

          doc.fillColor(
            '#000000'
          );

          const headerX = 100;
          const headerWidth = 395;

          doc
            .font(boldFont)
            .fontSize(11.5)
            .text(
              'УНИВЕРЗИТЕТ “Св. КИРИЛ И МЕТОДИЈ” во СКОПЈЕ',
              headerX,
              58,
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
              86,
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
              'ИНФОРМАТИЧКИ ТЕХНОЛОГИИ',
              headerX,
              108,
              {
                width:
                  headerWidth,
                align:
                  'center'
              }
            );

          doc
            .font(boldFont)
            .fontSize(
              bodyFontSize
            )
            .text(
              'Датум:',
              72,
              170,
              {
                continued:
                  true
              }
            );

          doc
            .font(regularFont)
            .fontSize(
              bodyFontSize
            )
            .text(
              ` ${submitDateValue}`
            );

          doc
            .font(boldFont)
            .fontSize(
              bodyFontSize
            )
            .text(
              'Архивски број:',
              350,
              170,
              {
                continued:
                  true
              }
            );

          doc
            .font(regularFont)
            .fontSize(
              bodyFontSize
            )
            .text(
              ` ${archiveNumberValue}`
            );

          doc
            .font(boldFont)
            .fontSize(16)
            .text(
              'Молба',
              0,
              225,
              {
                align:
                  'center'
              }
            );

          let y =
            bodyStartY;

          doc
            .font(boldFont)
            .fontSize(
              bodyFontSize
            )
            .text(
              'Наслов на молбата:',
              leftX,
              y,
              {
                continued:
                  true
              }
            );

          doc
            .font(regularFont)
            .fontSize(
              bodyFontSize
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
            doc.y + 10;

          doc
            .font(boldFont)
            .fontSize(
              bodyFontSize
            )
            .text(
              'Студент:',
              leftX,
              y,
              {
                continued:
                  true
              }
            );

          doc
            .font(regularFont)
            .fontSize(
              bodyFontSize
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
            doc.y + 10;

          doc
            .font(boldFont)
            .fontSize(
              bodyFontSize
            )
            .text(
              'Семестар и учебна година:',
              leftX,
              y,
              {
                continued:
                  true
              }
            );

          doc
            .font(regularFont)
            .fontSize(
              bodyFontSize
            )
            .text(
              ` ${semesterValue} ${academicYearValue}${molba.ciklus ? ' / ' + molba.ciklus + ' циклус' : ''}`,
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
              bodyFontSize
            )
            .text(
              'Опис на молбата:',
              leftX,
              y,
              {
                continued:
                  true
              }
            );

          doc
            .font(regularFont)
            .fontSize(
              bodyFontSize
            )
            .text(
              ` ${descriptionValue || '-'}`,
              {
                width:
                  contentWidth,
                lineGap:
                  4
              }
            );

          const statusHeight =
            doc.heightOfString(
              `Статус: ${statusValue}`,
              {
                width:
                  contentWidth,
                lineGap:
                  2,
                font:
                  regularFont,
                size:
                  bodyFontSize
              }
            );

          const feedbackHeight =
            shouldRenderFeedback
              ? doc.heightOfString(
                  `Повратна информација: ${feedbackValue}`,
                  {
                    width:
                      contentWidth,
                    lineGap:
                      3,
                    font:
                      regularFont,
                    size:
                      bodyFontSize
                  }
                ) + 18
              : 0;

          const confirmationHeight =
            includeConfirmation
              ? doc.heightOfString(
                  confirmationText,
                  {
                    width:
                      contentWidth,
                    lineGap:
                      2,
                    font:
                      regularFont,
                    size:
                      CONFIRMATION_FONT_SIZE
                  }
                )
              : 0;

          const gapBetweenBlocks =
            14;

          const footerReserve =
            statusHeight +
            feedbackHeight +
            confirmationHeight +
            gapBetweenBlocks +
            18;

          const pageBottom =
            doc.page.height -
            doc.page.margins.bottom;

          let statusY =
            doc.y + 28;

          if (
            includeConfirmation
          ) {
            statusY =
              Math.max(
                statusY,
                pageBottom -
                  footerReserve
              );
          }

          if (
            statusY +
              footerReserve >
              pageBottom + 1
          ) {
            doc.addPage();

            statusY =
              doc.page.height -
              doc.page.margins.bottom -
              footerReserve;
          }

          doc
            .font(boldFont)
            .fontSize(
              bodyFontSize
            )
            .text(
              'Статус:',
              leftX,
              statusY,
              {
                continued:
                  true
              }
            );

          doc
            .font(regularFont)
            .fontSize(
              bodyFontSize
            )
            .text(
              ` ${statusValue}`,
              {
                width:
                  contentWidth
              }
            );

          if (
            shouldRenderFeedback
          ) {
            doc
              .font(boldFont)
              .fontSize(
                bodyFontSize
              )
              .text(
                'Повратна информација:',
                leftX,
                doc.y + 18,
                {
                  continued:
                    true
                }
              );

            doc
              .font(regularFont)
              .fontSize(
                bodyFontSize
              )
              .text(
                ` ${feedbackValue}`,
                {
                  width:
                    contentWidth,
                  lineGap:
                    3
                }
              );
          }

          if (
            includeConfirmation
          ) {
            const confirmationHeightNow =
              doc.heightOfString(
                confirmationText,
                {
                  width:
                    contentWidth,
                  lineGap:
                    2,
                  font:
                    regularFont,
                  size:
                    CONFIRMATION_FONT_SIZE
                }
              );

            let confirmationY =
              Math.max(
                doc.y + 10,
                doc.page.height -
                  doc.page.margins.bottom -
                  confirmationHeightNow
              );

            if (
              confirmationY +
                confirmationHeightNow >
              doc.page.height -
                doc.page.margins.bottom +
                1
            ) {
              doc.addPage();

              const finalBlockHeight =
                statusHeight +
                feedbackHeight +
                confirmationHeightNow +
                gapBetweenBlocks;

              const finalStatusY =
                doc.page.height -
                doc.page.margins.bottom -
                finalBlockHeight;

              doc
                .font(boldFont)
                .fontSize(
                  bodyFontSize
                )
                .text(
                  'Статус:',
                  leftX,
                  finalStatusY,
                  {
                    continued:
                      true
                  }
                );

              doc
                .font(regularFont)
                .fontSize(
                  bodyFontSize
                )
                .text(
                  ` ${statusValue}`,
                  {
                    width:
                      contentWidth
                  }
                );

              if (
                shouldRenderFeedback
              ) {
                doc
                  .font(boldFont)
                  .fontSize(
                    bodyFontSize
                  )
                  .text(
                    'Повратна информација:',
                    leftX,
                    doc.y + 18,
                    {
                      continued:
                        true
                    }
                  );

                doc
                  .font(regularFont)
                  .fontSize(
                    bodyFontSize
                  )
                  .text(
                    ` ${feedbackValue}`,
                    {
                      width:
                        contentWidth,
                      lineGap:
                        3
                    }
                  );
              }

              confirmationY =
                doc.page.height -
                doc.page.margins.bottom -
                confirmationHeightNow;
            }

            doc
              .font(regularFont)
              .fontSize(
                CONFIRMATION_FONT_SIZE
              )
              .text(
                confirmationText,
                leftX,
                confirmationY,
                {
                  width:
                    contentWidth,
                  lineGap:
                    2,
                  align:
                    'left'
                }
              );
          }

          doc.end();
        } catch (error) {
          reject(error);
        }
      }
    );

    return {
      buffer:
        Buffer.concat(
          chunks
        ),
      pageCount
    };
  };

  const bodyOnly =
    await buildPdf(
      BASE_BODY_FONT_SIZE,
      false,
      'body-only'
    );

  let selectedBodyFontSize =
    BASE_BODY_FONT_SIZE;

  let finalPdf;

  if (
    bodyOnly.pageCount > 1
  ) {
    finalPdf =
      await buildPdf(
        BASE_BODY_FONT_SIZE,
        true,
        'multi-page'
      );
  } else {
    finalPdf =
      await buildPdf(
        BASE_BODY_FONT_SIZE,
        true,
        'adaptive'
      );

    if (
      finalPdf.pageCount > 1
    ) {
      for (
        let size =
          BASE_BODY_FONT_SIZE -
          BODY_FONT_STEP;
        size >=
          MIN_BODY_FONT_SIZE;
        size -=
          BODY_FONT_STEP
      ) {
        const candidate =
          await buildPdf(
            Number(
              size.toFixed(2)
            ),
            true,
            'adaptive'
          );

        if (
          candidate.pageCount === 1
        ) {
          selectedBodyFontSize =
            Number(
              size.toFixed(2)
            );

          finalPdf =
            candidate;

          break;
        }
      }

      if (
        finalPdf.pageCount > 1
      ) {
        selectedBodyFontSize =
          MIN_BODY_FONT_SIZE;

        finalPdf =
          await buildPdf(
            MIN_BODY_FONT_SIZE,
            true,
            'multi-page'
          );
      }
    }
  }

  const tempPath =
    `${fullPath}.tmp-${process.pid}-${Date.now()}`;

  fs.writeFileSync(
    tempPath,
    finalPdf.buffer
  );

  if (
    fs.existsSync(
      fullPath
    )
  ) {
    fs.rmSync(
      fullPath,
      {
        force:
          true
      }
    );
  }

  fs.renameSync(
    tempPath,
    fullPath
  );

  console.log(
    `[PDF] molba=${molba.molbaId} pages=${finalPdf.pageCount} bodyFont=${selectedBodyFontSize}pt confirmation=${CONFIRMATION_FONT_SIZE}pt`
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
      ciklus,
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

        (ciklus && ciklus !== 'site') ||

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


    if (ciklus && ciklus !== 'site' && allowedCiklusi.has(ciklus)) {
      where.ciklus = ciklus;
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


    // Only administrators receive the staff account registry.
    let adminAccounts = [];
    let adminCsrfToken = null;
    if (user.role === ROLE.ADMIN) {
      if (!(await isCurrentAdminAuthorized(user.userId))) {
        return res.status(403).send('Немате активна администраторска улога. Најавете се повторно.');
      }
      adminCsrfToken = ensureAdminRoleCsrf(req);
      const users = await User.findAll({
        include: [{
          model: Role,
          as: 'roles',
          where: { tip: { [Op.in]: Object.values(roleTipByRole) } },
          required: true,
          through: { attributes: [] }
        }],
        order: [['email', 'ASC']]
      });
      adminAccounts = users.map((account) => ({
        userId: account.userId,
        email: account.email,
        ime: account.ime || '',
        prezime: account.prezime || '',
        authServer: account.authServer || 'makedon',
        roles: account.roles.map((role) => {
          const value = staffRoleValueByTip[role.tip];
          return { value, label: getRoleLabel(value) };
        }).filter((role) => !!role.value).sort((a, b) => a.label.localeCompare(b.label))
      }));
    }

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

        adminAccounts,
        adminCsrfToken,
        adminRoleOptions,
        currentCiklus: ciklus || 'site',

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
   GET /dashboard/admin-users/:id - staff account details
========================================================= */
exports.getAdminUserDetail = async (req, res) => {
  const actor = requireStaff(req, res);
  if (!actor) return;
  if (actor.role !== ROLE.ADMIN || !(await isCurrentAdminAuthorized(actor.userId))) {
    return res.status(403).send('Само администратор има пристап до овој преглед.');
  }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).send('Невалиден корисник.');
  }
  try {
    const target = await User.findByPk(id, {
      include: [{ model: Role, as: 'roles',
        where: { tip: { [Op.in]: Object.values(roleTipByRole) } },
        required: true, through: { attributes: [] } }]
    });
    if (!target) return res.status(404).send('Административниот корисник не е пронајден.');
    const roles = target.roles.map((r) => {
      const value = staffRoleValueByTip[r.tip];
      return value ? { value, label: getRoleLabel(value) } : null;
    }).filter(Boolean).sort((a, b) => a.label.localeCompare(b.label));

    return res.render('detail-admin', {
      title: 'Детали за административен корисник',
      viewer: actor,
      isImpersonating: false,
      convertNameToCyrillic,
      getRoleLabel,
      account: {
        userId: target.userId,
        email: target.email,
        ime: target.ime || '',
        prezime: target.prezime || '',
        authServer: target.authServer || 'makedon',
        roles
      },
      adminRoleOptions,
      adminCsrfToken: ensureAdminRoleCsrf(req),
      success: req.flash('success'),
      error: req.flash('error')
    });
  } catch (error) {
    console.error('Admin detail error:', error);
    return res.status(500).send('Неуспешно вчитување на корисникот.');
  }
};

/* =========================================================
   POST /dashboard/admin-users/:id/name - edit existing User names
========================================================= */
exports.updateAdminUserName = async (req, res) => {
  const actor = requireStaff(req, res);
  if (!actor) return;
  if (actor.role !== ROLE.ADMIN || !(await isCurrentAdminAuthorized(actor.userId))) {
    return res.status(403).send('Само администратор може да менува имиња.');
  }
  if (!validAdminRoleCsrf(req)) {
    return res.status(403).send('Невалидна сесија. Освежете ја страницата.');
  }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).send('Невалиден корисник.');
  }
  const ime = normalizeStaffName(req.body.ime);
  const prezime = normalizeStaffName(req.body.prezime);
  if (!validStaffNamePair(ime, prezime)) {
    req.flash('error', 'Внесете валидно име и презиме. Двете полиња се задолжителни.');
    return res.redirect(`/dashboard/admin-users/${id}`);
  }
  try {
    const target = await User.findByPk(id, {
      include: [{ model: Role, as: 'roles',
        where: { tip: { [Op.in]: Object.values(roleTipByRole) } },
        required: true, through: { attributes: [] } }]
    });
    if (!target) return res.status(404).send('Административниот корисник не е пронајден.');
    await target.update({ ime, prezime });
    if (id === actor.userId) {
      req.session.user.ime = ime;
      req.session.user.prezime = prezime;
    }
    req.flash('success', 'Името и презимето се успешно зачувани.');
    return res.redirect('/dashboard');
  } catch (error) {
    console.error('Admin name update error:', error);
    req.flash('error', 'Неуспешно зачувување на името и презимето.');
    return res.redirect(`/dashboard/admin-users/${id}`);
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


    const requestedDetailId = Number(req.body.adminDetailUserId);
    const fromDetails = Number.isSafeInteger(requestedDetailId) && requestedDetailId > 0;
    const returnPath = fromDetails ? `/dashboard/admin-users/${requestedDetailId}` : '/dashboard';

    try {
      if (!validAdminRoleCsrf(req)) {
        return res.status(403).send('Невалидна сесија за промена на улоги. Освежете ја страницата.');
      }
      if (!(await isCurrentAdminAuthorized(user.userId))) {
        return res.status(403).send('Администраторската улога повеќе не е активна.');
      }
      const ime = normalizeStaffName(req.body.ime);
      const prezime = normalizeStaffName(req.body.prezime);
      // The detail-page role form does not submit names: it only adds a role.
      if (!fromDetails && !validStaffNamePair(ime, prezime)) {
        req.flash('error', 'Внесете валидно име и презиме за административниот корисник.');
        return res.redirect(returnPath);
      }

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
          'makedon'
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

        return res.redirect(returnPath);
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

        return res.redirect(returnPath);
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

        return res.redirect(returnPath);
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

        return res.redirect(returnPath);
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

        return res.redirect(returnPath);
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

            if (fromDetails && (!targetUser || targetUser.userId !== requestedDetailId)) {
              throw new Error('Несовпаѓање меѓу email и избраниот корисник.');
            }
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
                !targetUser.authServer
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


              // An explicit main-form assignment also updates the existing name.
              // A detail-page role assignment keeps the stored name unchanged.
              if (!fromDetails && (targetUser.ime !== ime || targetUser.prezime !== prezime)) {
                await targetUser.update({ ime, prezime }, { transaction });
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

            // Use the manually provided name in the existing users.ime/prezime fields.
            if (!validStaffNamePair(ime, prezime)) {
              throw new Error('Внесете име и презиме за новиот административен корисник.');
            }
            const nameParts = { ime, prezime };


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

        return res.redirect(returnPath);
      }


      req.flash(
        'success',
        `Улогата „${getRoleLabel(role)}“ е успешно доделена на ${email}.`
      );


      return res.redirect('/dashboard');

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

        return res.redirect(returnPath);
      }


      req.flash(
        'error',
        'Настана грешка при доделување улога.'
      );

      return res.redirect(returnPath);
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
   POST /dashboard/users/:id/remove-role
========================================================= */
exports.removeRoleFromUser = async (req, res) => {
  const actor = requireStaff(req, res);
  if (!actor) return;
  if (actor.role !== ROLE.ADMIN) {
    return res.status(403).send('Само администратор може да отстранува улоги.');
  }

  try {
    if (!validAdminRoleCsrf(req)) {
      return res.status(403).send('Невалидна сесија. Освежете ја страницата.');
    }
    if (!(await isCurrentAdminAuthorized(actor.userId))) {
      return res.status(403).send('Администраторската улога повеќе не е активна.');
    }
    const targetId = Number(req.params.id);
    const requested = String(req.body.role || '');
    if (!Number.isSafeInteger(targetId) || targetId <= 0 ||
        (requested !== 'all' && !assignableStaffRoles.has(requested))) {
      return res.status(400).send('Невалиден корисник или улога.');
    }

    const removed = await User.sequelize.transaction(async (transaction) => {
      const target = await User.findByPk(targetId, {
        transaction,
        lock: transaction.LOCK.UPDATE
      });
      if (!target) throw new Error('Корисникот не постои.');
      // Lock the Admin role so concurrent removals cannot remove the last admin.
      const adminRole = await Role.findOne({
        where: { tip: 'Admin' }, transaction, lock: transaction.LOCK.UPDATE
      });
      if (!adminRole) throw new Error('Администраторската улога не постои.');
      const roleDefs = await Role.findAll({
        where: { tip: { [Op.in]: Object.values(roleTipByRole) } }, transaction
      });
      const idByValue = new Map(roleDefs.map((role) => [staffRoleValueByTip[role.tip], role.roleId]));
      const assigned = await UserRole.findAll({
        where: { userId: targetId, roleId: { [Op.in]: roleDefs.map((r) => r.roleId) } },
        transaction
      });
      const selectedIds = requested === 'all'
        ? assigned.map((item) => item.roleId)
        : assigned.filter((item) => item.roleId === idByValue.get(requested)).map((item) => item.roleId);
      if (!selectedIds.length) throw new Error('Избраната улога не е доделена на корисникот.');

      if (selectedIds.includes(adminRole.roleId)) {
        if (targetId === actor.userId) {
          throw new Error('Не можете сами да си ја отстраните администраторската улога.');
        }
        const adminCount = await UserRole.count({
          where: { roleId: adminRole.roleId }, transaction
        });
        if (adminCount <= 1) throw new Error('Не може да се отстрани последниот администратор.');
      }
      await UserRole.destroy({
        where: { userId: targetId, roleId: { [Op.in]: selectedIds } }, transaction
      });
      const remaining = await UserRole.count({
        where: { userId: targetId, roleId: { [Op.in]: roleDefs.map((r) => r.roleId) } },
        transaction
      });
      return { email: target.email, count: selectedIds.length, remaining };
    });

    req.flash('success', `Отстранети се ${removed.count} улога/улоги од ${removed.email}.`);
    return res.redirect('/dashboard');
  } catch (error) {
    console.error('Remove role error:', error);
    req.flash('error', error.message || 'Неуспешно отстранување на улога.');
    return res.redirect('/dashboard');
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


// MOLBI_ORIGINAL_UPLOAD_FILENAME_V1
// Preserve the original PDF filename after Multer finishes uploading.
// Existing files are never overwritten.

const preserveOriginalStudentPdfName = (file) => {

  if (!file || !file.path || !file.originalname) {
    throw new Error('Missing uploaded document information.');
  }

  // Never use a client-provided directory as the destination.
  const original = path.basename(
    String(file.originalname).replace(/\\/g, '/')
  );

  const clean = original
    .replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_')
    .replace(/[. ]+$/g, '');

  const ext = path.extname(clean);

  if (ext.toLowerCase() !== '.pdf') {
    throw new Error('Only PDF documents are allowed.');
  }

  const stem =
    clean.slice(0, -ext.length)
      .replace(/^\.+/, '')
      .trim() || 'dokument';

  const sourcePath = path.resolve(file.path);

  const destinationDir = path.dirname(sourcePath);

  for (let number = 0; number < 10000; number += 1) {

    const suffix =
      number === 0 ? '' : ` (${number + 1})`;

    const capacity =
      180 - Buffer.byteLength(ext + suffix, 'utf8');

    let limitedStem = '';

    for (const character of stem) {

      if (
        Buffer.byteLength(
          limitedStem + character,
          'utf8'
        ) > capacity
      ) {
        break;
      }

      limitedStem += character;
    }

    const filename =
      `${limitedStem || 'dokument'}${suffix}${ext}`;

    const destination = path.join(
      destinationDir,
      filename
    );

    if (destination === sourcePath) {

      file.filename = filename;

      return;
    }

    try {

      // Fail if the destination already exists.
      fs.copyFileSync(
        sourcePath,
        destination,
        fs.constants.COPYFILE_EXCL
      );

    } catch (error) {

      if (error.code === 'EEXIST') {
        continue;
      }

      throw error;
    }

    try {

      fs.unlinkSync(sourcePath);

    } catch (error) {

      fs.unlinkSync(destination);

      throw error;
    }

    // This is the filename saved in Molba.urlPath.
    file.path = destination;

    file.filename = filename;

    return;
  }

  throw new Error('Too many files with the same name.');
};

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
        ciklus,
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


      if (!allowedCiklusi.has(ciklus)) {
        req.flash('error', 'Изберете Прв или Втор циклус на студии.');
        return res.redirect('/dashboard/nova-molba');
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
      preserveOriginalStudentPdfName(req.file);

      await Molba.create({
        userId:
          user.userId,

        naslov:
          naslov.trim(),

        semestar,

        ciklus,

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


      // Do not guess a historic decision time from an HTTP request log.
      if (!molba.decisionAt || !molba.decisionByUserId) {
        req.flash('error', 'Недостига запишан датум/час или автор на одлуката. '
          + 'Не може да се генерира потврда со измислени податоци.');
        return res.redirect('/dashboard');
      }
      const decisionSigner = await User.findByPk(molba.decisionByUserId, {
        attributes: ['ime', 'prezime']
      });
      if (!decisionSigner || !decisionSigner.ime || !decisionSigner.prezime) {
        req.flash('error', 'Не е пронајдено име и презиме на продеканот што ја донел одлуката.');
        return res.redirect('/dashboard');
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
          molba,
          decisionSigner
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
        /предолг|повеќе од една страница/.test(error.message || '')
          ? error.message
          : 'Настана грешка при генерирање на PDF документот.'
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

      // The source of truth is the successful decision action, not audit.csv.
      molba.decisionAt = new Date();
      molba.decisionByUserId = user.userId;

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