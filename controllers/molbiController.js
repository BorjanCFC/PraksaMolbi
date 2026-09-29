const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Op } = require('sequelize');
const PDFDocument = require('pdfkit');
const sequelize = require('../config/database');

const {
  Molba,
  User,
  Student,
  Role,
  UserRole,
  AcademicPeriod
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

// MOLBI_STUDENT_REQUEST_NUMBERING_PDF_NAMES_V1
const {
  convertNameToCyrillic,
  convertNameToLatin
} = require('../utils/cyrillicConverter');

const {
  getStudentDocumentPath,
  getArchivePath
} = require('../utils/uploadPathHelper');

// MOLBI_INDEX_FROM_EMAIL_MANUAL_MAJOR_V1
const {
  syncStudentIndexFromEmail
} = require('../utils/studentEmailIdentity');


/* =========================================================
   CONSTANTS
========================================================= */

// MOLBI_STUDENT_REVISION_V1
const allowedStatuses = new Set([
  'Во процес',
  'Забелешка',
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
  'ЕЕМП',
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

// MOLBI_ACADEMIC_PERIOD_ARCHIVE_V1
const ACADEMIC_PERIOD_STATUS = Object.freeze({
  OPEN: 'OPEN',
  CLOSED: 'CLOSED'
});

const getOpenAcademicPeriod = async (options = {}) =>
  AcademicPeriod.findOne({
    where: { status: ACADEMIC_PERIOD_STATUS.OPEN },
    order: [['academicPeriodId', 'DESC']],
    ...options
  });

const isValidAcademicYear = (value) => {
  const clean = String(value || '').trim();
  if (!academicYearPattern.test(clean)) return false;
  const [startYear, endYear] = clean.split('/').map(Number);
  return endYear === startYear + 1;
};

const formatAcademicPeriodLabel = (period) => {
  if (!period) return 'Нема отворен семестар';
  return `${period.semestar} ${period.ucebnaGodina}`;
};

const isMolbaInOpenAcademicPeriod = async (molba, options = {}) => {
  if (!molba || !molba.academicPeriodId) return false;

  const period = await AcademicPeriod.findByPk(
    molba.academicPeriodId,
    options
  );

  return Boolean(
    period &&
    period.status === ACADEMIC_PERIOD_STATUS.OPEN
  );
};



const WORKFLOW_STAGE = {
  SUBMITTED: 'SUBMITTED',
  ARCHIVED: 'ARCHIVED',
  SERVICE_REVIEWED: 'SERVICE_REVIEWED',
  STUDENT_REVISION: 'STUDENT_REVISION',
  DECIDED: 'DECIDED',
  COMPLETED: 'COMPLETED'
};

const WORKFLOW_STAGE_LABEL = {
  SUBMITTED: 'Поднесена - чека архивирање',
  ARCHIVED: 'Архивирана - чека проверка од Студентска служба',
  SERVICE_REVIEWED: 'Проверена од Студентска служба - чека одлука од Продекан',
  STUDENT_REVISION: 'Забелешка од Продекан - чека измена од студент',
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

  if (molba.status === 'Забелешка') {
    return WORKFLOW_STAGE.STUDENT_REVISION;
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
  },
  {
    model: AcademicPeriod,
    as: 'academicPeriod',
    required: false
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


// MOLBI_PROFESSIONAL_REVISION_UI_V3
// Some multipart parsers expose UTF-8 filenames as Latin-1 text (e.g. "Ð¼Ð¾Ð»Ð±Ð°.pdf").
// Decode only when the typical mojibake markers are present so normal names stay untouched.
const decodeLegacyUtf8FileName = (value) => {
  const source = String(value || '');

  if (!/[ÃÂÐÑâ]/.test(source)) {
    return source;
  }

  try {
    const decoded = Buffer.from(source, 'latin1').toString('utf8');

    if (decoded && !decoded.includes('\uFFFD')) {
      return decoded;
    }
  } catch (error) {
    // Keep the original value if decoding is not possible.
  }

  return source;
};

const getReadableStoredFileName = (storedPath) => {
  if (!storedPath) return '';

  const baseName = path.basename(
    String(storedPath).replace(/\\/g, '/')
  );

  return decodeLegacyUtf8FileName(baseName);
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
  molba,
  decisionSigner = null
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

  // Filesystem name is always Latin/ASCII even when names are stored in Cyrillic.
  const latinIme = convertNameToLatin(molba.student.ime || '');
  const latinPrezime = convertNameToLatin(molba.student.prezime || '');

  const safeStudentName =
    `${latinIme}${latinPrezime}`
      .replace(/\s+/g, '')
      .replace(/[^A-Za-z0-9]/g, '') ||
    `Student${molba.userId}`;

  const indexForFileName =
    molba.student.brIndeks ||
    (
      molba.student.studentProfile
        ? molba.student.studentProfile.brIndeks
        : null
    ) ||
    'NoIndex';

  const safeIndex =
    String(indexForFileName)
      .trim()
      .replace(/\//g, '-')
      .replace(/[^A-Za-z0-9-]/g, '') ||
    'NoIndex';

  const fileName =
    `Molba-${molba.molbaId}-${safeStudentName}-${safeIndex}.pdf`;

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

  /*
   * The proof text MUST use the actual user who made the decision
   * and the decision timestamp stored in the database.
   */
  let resolvedDecisionSigner =
    decisionSigner;

  if (
    !resolvedDecisionSigner &&
    molba.decisionByUserId
  ) {
    resolvedDecisionSigner =
      await User.findByPk(
        molba.decisionByUserId,
        {
          attributes: [
            'ime',
            'prezime'
          ]
        }
      );
  }

  if (
    !resolvedDecisionSigner ||
    !resolvedDecisionSigner.ime ||
    !resolvedDecisionSigner.prezime
  ) {
    throw new Error(
      'Не е пронајдено име и презиме на продеканот што ја донел одлуката.'
    );
  }

  if (!molba.decisionAt) {
    throw new Error(
      'Недостига датум/час на одлуката во базата.'
    );
  }

  const prodekanFullName =
    `${convertNameToCyrillic(resolvedDecisionSigner.ime || '')} ${convertNameToCyrillic(resolvedDecisionSigner.prezime || '')}`.trim();

  const decisionDateTime =
    formatDecisionDateTimeMk(
      molba.decisionAt
    );

  const confirmationText =
    `Овој документ е дигитално потврден од продеканот за настава на Факултетот за електротехника и информациски технологии, проф. д-р ${prodekanFullName} на ${decisionDateTime.date} во ${decisionDateTime.time}.`;

  /*
   * Fixed sizes:
   * - university/faculty header stays unchanged;
   * - date/archive line stays unchanged;
   * - "Молба" stays unchanged.
   * Only the content from "Наслов на молбата:" downward is adaptive.
   */
  const BASE_BODY_FONT_SIZE = 14;
  const MIN_BODY_FONT_SIZE = 11;
  const BODY_FONT_STEP = 0.25;

  /* Requested +0.5 pt compared with the previous confirmation size. */
  const CONFIRMATION_FONT_SIZE = 9.8;

  const margins = {
    top: 56,
    left: 56,
    right: 56,
    bottom: 56
  };

  const leftX = 72;
  const contentWidth = 450;
  const bodyStartY = 283;

  const getBodyLineGap = (
    baseGap,
    bodyFontSize
  ) => {
    const scale =
      bodyFontSize /
      BASE_BODY_FONT_SIZE;

    return Math.max(
      0.6,
      Number(
        (baseGap * scale).toFixed(2)
      )
    );
  };

  const buildPdf = async (
    bodyFontSize,
    includeConfirmation
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
                fs.existsSync(fontSet.regular) &&
                fs.existsSync(fontSet.bold)
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
            fs.existsSync(ukimLogoPath)
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
                align: 'left',
                valign: 'top'
              }
            );
          }

          if (
            fs.existsSync(feitRightLogoPath)
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
                align: 'right',
                valign: 'top'
              }
            );
          }

          doc.fillColor('#000000');

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
                width: headerWidth,
                align: 'center',
                lineBreak: false
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
                width: headerWidth,
                align: 'center'
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
                width: headerWidth,
                align: 'center'
              }
            );

          /* Fixed metadata size — do NOT shrink this part. */
          doc
            .font(boldFont)
            .fontSize(BASE_BODY_FONT_SIZE)
            .text(
              'Датум:',
              72,
              170,
              {
                continued: true
              }
            );

          doc
            .font(regularFont)
            .fontSize(BASE_BODY_FONT_SIZE)
            .text(
              ` ${submitDateValue}`
            );

          doc
            .font(boldFont)
            .fontSize(BASE_BODY_FONT_SIZE)
            .text(
              'Архивски број:',
              350,
              170,
              {
                continued: true
              }
            );

          doc
            .font(regularFont)
            .fontSize(BASE_BODY_FONT_SIZE)
            .text(
              ` ${archiveNumberValue}`
            );

          /* Fixed title size. */
          doc
            .font(boldFont)
            .fontSize(16)
            .text(
              'Молба',
              0,
              225,
              {
                align: 'center'
              }
            );

          let y = bodyStartY;

          /* From here downward only this body font is adaptive. */
          doc
            .font(boldFont)
            .fontSize(bodyFontSize)
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
            .fontSize(bodyFontSize)
            .text(
              ` ${titleValue}`,
              {
                width: contentWidth,
                lineGap: getBodyLineGap(3, bodyFontSize)
              }
            );

          y = doc.y + 10;

          doc
            .font(boldFont)
            .fontSize(bodyFontSize)
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
            .fontSize(bodyFontSize)
            .text(
              ` ${studentLine}`,
              {
                width: contentWidth,
                lineGap: getBodyLineGap(3, bodyFontSize)
              }
            );

          y = doc.y + 10;

          doc
            .font(boldFont)
            .fontSize(bodyFontSize)
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
            .fontSize(bodyFontSize)
            .text(
              ` ${semesterValue} ${academicYearValue}${molba.ciklus ? ' / ' + molba.ciklus + ' циклус' : ''}`,
              {
                width: contentWidth,
                lineGap: getBodyLineGap(3, bodyFontSize)
              }
            );

          y = doc.y + getBodyLineGap(14, bodyFontSize);

          doc
            .font(boldFont)
            .fontSize(bodyFontSize)
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
            .fontSize(bodyFontSize)
            .text(
              ` ${descriptionValue || '-'}`,
              {
                width: contentWidth,
                lineGap: getBodyLineGap(4, bodyFontSize)
              }
            );

          /* -----------------------------------------------------
             FINAL BLOCK / FOOTER
             -----------------------------------------------------
             Required result:
             - always on the last page;
             - near the bottom of that page;
             - immediately after the status/feedback block;
             - black horizontal line above the confirmation sentence;
             - confirmation centered;
             - confirmation is never placed at the top of a page.
          ----------------------------------------------------- */
          const statusText =
            `Статус: ${statusValue}`;

          const statusHeight =
            doc.heightOfString(
              statusText,
              {
                width: contentWidth,
                lineGap: 2,
                font: regularFont,
                size: bodyFontSize
              }
            );

          const feedbackHeight =
            shouldRenderFeedback
              ? doc.heightOfString(
                  `Повратна информација: ${feedbackValue}`,
                  {
                    width: contentWidth,
                    lineGap: getBodyLineGap(3, bodyFontSize),
                    font: regularFont,
                    size: bodyFontSize
                  }
                )
              : 0;

          const confirmationHeight =
            includeConfirmation
              ? doc.heightOfString(
                  confirmationText,
                  {
                    width: contentWidth,
                    lineGap: 2,
                    font: regularFont,
                    size: CONFIRMATION_FONT_SIZE,
                    align: 'center'
                  }
                )
              : 0;

          const gapAfterStatus =
            shouldRenderFeedback ? 12 : 24;

          const gapAfterFeedback =
            shouldRenderFeedback ? 16 : 0;

          const lineThickness = 0.8;
          const lineToConfirmation = 12;
          const bottomPadding = 1;

          const confirmationBlockHeight =
            confirmationHeight +
            lineToConfirmation +
            lineThickness;

          const footerHeight =
            statusHeight +
            gapAfterStatus +
            feedbackHeight +
            gapAfterFeedback +
            confirmationBlockHeight +
            bottomPadding;

          const pageBottom =
            doc.page.height -
            doc.page.margins.bottom;

          let footerTop =
            pageBottom -
            footerHeight;

          /*
           * If the current page does not have enough room for the complete
           * footer, move the entire footer to a new final page.  The body is
           * NOT reduced in this case unless the special one-page adaptive
           * mode outside this function asks for a smaller font.
           */
          if (
            footerTop < doc.y + 12
          ) {
            if (includeConfirmation) {
              doc.addPage();

              footerTop =
                doc.page.height -
                doc.page.margins.bottom -
                footerHeight;
            } else {
              /* Body-only measurement: put status after the body normally. */
              footerTop =
                doc.y + 28;
            }
          }

          /* Status */
          let footerY =
            footerTop;

          doc
            .font(boldFont)
            .fontSize(bodyFontSize)
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
            .fontSize(bodyFontSize)
            .text(
              ` ${statusValue}`,
              {
                width: contentWidth,
                lineGap: 2
              }
            );

          /* Optional feedback remains directly under status. */
          if (shouldRenderFeedback) {
            doc
              .font(boldFont)
              .fontSize(bodyFontSize)
              .text(
                'Повратна информација:',
                leftX,
                footerY +
                  statusHeight +
                  12,
                {
                  continued: true
                }
              );

            doc
              .font(regularFont)
              .fontSize(bodyFontSize)
              .text(
                ` ${feedbackValue}`,
                {
                  width: contentWidth,
                  lineGap: getBodyLineGap(3, bodyFontSize)
                }
              );
          }

          if (includeConfirmation) {
            const lineY =
              footerTop +
              statusHeight +
              gapAfterStatus +
              feedbackHeight +
              gapAfterFeedback;

            /* Black horizontal line above the digital confirmation. */
            doc
              .save()
              .strokeColor('#000000')
              .lineWidth(lineThickness)
              .moveTo(
                leftX,
                lineY
              )
              .lineTo(
                leftX + contentWidth,
                lineY
              )
              .stroke()
              .restore();

            const confirmationY =
              lineY +
              lineThickness +
              lineToConfirmation;

            doc
              .font(regularFont)
              .fontSize(CONFIRMATION_FONT_SIZE)
              .text(
                confirmationText,
                leftX,
                confirmationY,
                {
                  width: contentWidth,
                  lineGap: 2,
                  align: 'center'
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
        Buffer.concat(chunks),
      pageCount
    };
  };

  /*
   * First measure the actual request body without the digital confirmation.
   * IMPORTANT:
   * - If the body already needs more than one page, keep the original body
   *   font size and allow multiple pages.
   * - If the body fits on one page but the final confirmation would make it
   *   spill to page 2, reduce ONLY the body from "Наслов..." downward until
   *   the complete document fits on one page.
   */
  const bodyOnly =
    await buildPdf(
      BASE_BODY_FONT_SIZE,
      false
    );

  let selectedBodyFontSize =
    BASE_BODY_FONT_SIZE;

  let finalPdf;

  if (bodyOnly.pageCount > 1) {
    finalPdf =
      await buildPdf(
        BASE_BODY_FONT_SIZE,
        true
      );
  } else {
    finalPdf =
      await buildPdf(
        BASE_BODY_FONT_SIZE,
        true
      );

    if (finalPdf.pageCount > 1) {
      for (
        let size =
          BASE_BODY_FONT_SIZE - BODY_FONT_STEP;
        size >= MIN_BODY_FONT_SIZE;
        size -= BODY_FONT_STEP
      ) {
        const candidate =
          await buildPdf(
            Number(size.toFixed(2)),
            true
          );

        if (candidate.pageCount === 1) {
          selectedBodyFontSize =
            Number(size.toFixed(2));

          finalPdf =
            candidate;

          break;
        }
      }

      /*
       * If the content is genuinely too long to fit on one page even after
       * reducing to the minimum readable size, keep it multi-page rather
       * than shrinking it any further.  The footer remains at the bottom of
       * the final page.
       */
      if (finalPdf.pageCount > 1) {
        selectedBodyFontSize =
          MIN_BODY_FONT_SIZE;

        finalPdf =
          await buildPdf(
            MIN_BODY_FONT_SIZE,
            true
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

  if (fs.existsSync(fullPath)) {
    fs.rmSync(
      fullPath,
      {
        force: true
      }
    );
  }

  fs.renameSync(
    tempPath,
    fullPath
  );

  console.log(
    `[PDF] molba=${molba.molbaId} pages=${finalPdf.pageCount} bodyFont=${selectedBodyFontSize}pt confirmation=${CONFIRMATION_FONT_SIZE}pt footer=bottom-line`
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
   ACADEMIC PERIOD MANAGEMENT + ARCHIVE
========================================================= */

exports.openAcademicPeriod = async (req, res) => {
  const actor = requireStaff(req, res);
  if (!actor) return;

  if (actor.role !== ROLE.ADMIN || !(await isCurrentAdminAuthorized(actor.userId))) {
    return res.status(403).send('Само администратор може да отвори семестар.');
  }

  if (!validAdminRoleCsrf(req)) {
    return res.status(403).send('Невалидна сесија. Освежете ја страницата.');
  }

  const semestar = String(req.body.semestar || '').trim();
  const ucebnaGodina = String(req.body.ucebnaGodina || '').trim();

  if (!allowedSemestri.has(semestar)) {
    req.flash('error', 'Изберете Зимски или Летен семестар.');
    return res.redirect('/dashboard');
  }

  if (!isValidAcademicYear(ucebnaGodina)) {
    req.flash('error', 'Учебната година мора да биде во формат 2026/2027.');
    return res.redirect('/dashboard');
  }

  try {
    await AcademicPeriod.sequelize.transaction(async (transaction) => {
      const openPeriod = await AcademicPeriod.findOne({
        where: { status: ACADEMIC_PERIOD_STATUS.OPEN },
        transaction,
        lock: transaction.LOCK.UPDATE
      });

      if (openPeriod) {
        throw new Error(`Веќе е отворен семестар ${formatAcademicPeriodLabel(openPeriod)}. Прво затворете го тековниот семестар.`);
      }

      const existing = await AcademicPeriod.findOne({
        where: { semestar, ucebnaGodina },
        transaction,
        lock: transaction.LOCK.UPDATE
      });

      if (existing) {
        throw new Error('Овој семестар и учебна година веќе постојат во системот и не може повторно да се отворат.');
      }

      await AcademicPeriod.create({
        semestar,
        ucebnaGodina,
        status: ACADEMIC_PERIOD_STATUS.OPEN,
        openedAt: new Date(),
        openedByUserId: actor.userId,
        closedAt: null,
        closedByUserId: null
      }, { transaction });
    });

    req.flash('success', `Успешно е отворен ${semestar} семестар ${ucebnaGodina}.`);
    return res.redirect('/dashboard');
  } catch (error) {
    console.error('Open academic period error:', error);
    req.flash('error', error.message || 'Неуспешно отворање на семестар.');
    return res.redirect('/dashboard');
  }
};

exports.closeAcademicPeriod = async (req, res) => {
  const actor = requireStaff(req, res);
  if (!actor) return;

  if (actor.role !== ROLE.ADMIN || !(await isCurrentAdminAuthorized(actor.userId))) {
    return res.status(403).send('Само администратор може да затвори семестар.');
  }

  if (!validAdminRoleCsrf(req)) {
    return res.status(403).send('Невалидна сесија. Освежете ја страницата.');
  }

  try {
    let closedLabel = '';

    await AcademicPeriod.sequelize.transaction(async (transaction) => {
      const period = await AcademicPeriod.findOne({
        where: { status: ACADEMIC_PERIOD_STATUS.OPEN },
        transaction,
        lock: transaction.LOCK.UPDATE
      });

      if (!period) {
        throw new Error('Во моментот нема отворен семестар.');
      }

      closedLabel = formatAcademicPeriodLabel(period);

      await period.update({
        status: ACADEMIC_PERIOD_STATUS.CLOSED,
        closedAt: new Date(),
        closedByUserId: actor.userId
      }, { transaction });
    });

    req.flash('success', `${closedLabel} е затворен и неговите молби се достапни во Архива на молби.`);
    return res.redirect('/dashboard');
  } catch (error) {
    console.error('Close academic period error:', error);
    req.flash('error', error.message || 'Неуспешно затворање на семестар.');
    return res.redirect('/dashboard');
  }
};

exports.getAcademicPeriodArchive = async (req, res) => {
  const actor = requireStaff(req, res);
  if (!actor) return;

  try {
    const rows = await AcademicPeriod.findAll({
      where: { status: ACADEMIC_PERIOD_STATUS.CLOSED }
    });

    const periods = await Promise.all(rows.map(async (period) => {
      const molbiCount = await Molba.count({
        where: { academicPeriodId: period.academicPeriodId }
      });

      return {
        ...period.get({ plain: true }),
        molbiCount
      };
    }));

    periods.sort((a, b) => {
      const ay = Number(String(a.ucebnaGodina || '').split('/')[0]) || 0;
      const by = Number(String(b.ucebnaGodina || '').split('/')[0]) || 0;
      if (ay !== by) return by - ay;
      const rank = { 'Летен': 1, 'Зимски': 0 };
      return (rank[b.semestar] ?? -1) - (rank[a.semestar] ?? -1);
    });

    return res.render('archive-semesters', {
      title: 'Архива на молби',
      viewer: actor,
      getRoleLabel,
      convertNameToCyrillic,
      formatDateMk,
      isImpersonating: false,
      periods,
      success: req.flash('success'),
      error: req.flash('error')
    });
  } catch (error) {
    console.error('Academic archive error:', error);
    req.flash('error', 'Настана грешка при вчитување на архивата.');
    return res.redirect('/dashboard');
  }
};

exports.getAcademicPeriodArchiveDetail = async (req, res) => {
  const actor = requireStaff(req, res);
  if (!actor) return;

  const periodId = Number(req.params.periodId);
  if (!Number.isSafeInteger(periodId) || periodId <= 0) {
    return res.status(400).send('Невалиден семестар.');
  }

  const {
    status,
    semestar,
    ucebnaGodina,
    ciklus,
    studentIndex,
    fromDate,
    toDate
  } = req.query;

  const hasActiveFilters = Boolean(
    (status && status !== 'site') ||
    (semestar && semestar !== 'site') ||
    (ucebnaGodina && ucebnaGodina !== 'site') ||
    (ciklus && ciklus !== 'site') ||
    String(studentIndex || '').trim() ||
    fromDate ||
    toDate
  );

  try {
    const period = await AcademicPeriod.findOne({
      where: {
        academicPeriodId: periodId,
        status: ACADEMIC_PERIOD_STATUS.CLOSED
      }
    });

    if (!period) {
      req.flash('error', 'Архивираниот семестар не е пронајден.');
      return res.redirect('/dashboard/archive');
    }

    const where = { academicPeriodId: periodId };

    if (status && status !== 'site' && allowedStatuses.has(status)) {
      where.status = status;
    }

    if (semestar && semestar !== 'site' && allowedSemestri.has(semestar)) {
      where.semestar = semestar;
    }

    if (
      ucebnaGodina &&
      ucebnaGodina !== 'site' &&
      academicYearPattern.test(ucebnaGodina)
    ) {
      where.ucebnaGodina = ucebnaGodina;
    }

    if (ciklus && ciklus !== 'site' && allowedCiklusi.has(ciklus)) {
      where.ciklus = ciklus;
    }

    addDateFilter(where, fromDate, toDate);

    const molbi = await Molba.findAll({
      where,
      include: buildMolbaStudentInclude(studentIndex),
      order: newestFirstOrder
    });

    prepareStudentData(molbi);

    const totalMolbiCount = await Molba.count({
      where: { academicPeriodId: periodId }
    });

    return res.render('archive-semester-detail', {
      title: `Архива - ${formatAcademicPeriodLabel(period)}`,
      viewer: actor,
      getRoleLabel,
      convertNameToCyrillic,
      formatDateMk,
      isImpersonating: false,
      period,
      molbi,
      totalMolbiCount,
      hasActiveFilters,
      academicYearOptions: [period.ucebnaGodina],
      currentStatus: status || 'site',
      currentSemestar: semestar || 'site',
      currentAcademicYear: ucebnaGodina || 'site',
      currentCiklus: ciklus || 'site',
      currentStudentIndex: String(studentIndex || '').trim(),
      currentFromDate: fromDate || '',
      currentToDate: toDate || ''
    });
  } catch (error) {
    console.error('Academic archive detail error:', error);
    req.flash('error', 'Настана грешка при вчитување на архивираниот семестар.');
    return res.redirect('/dashboard/archive');
  }
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

      await syncStudentIndexFromEmail({
        userId: user.userId,
        email: user.email
      });

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
       * active = Vo proces / Zabeleshka
       * completed = Odobrena / Odbiena
       */
      const activeMolbi =
        molbi.filter(
          (item) =>
            item.status === 'Во процес' ||
            item.status === 'Забелешка'
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

    const activeAcademicPeriod = await getOpenAcademicPeriod();

    const where = {
      academicPeriodId: activeAcademicPeriod
        ? activeAcademicPeriod.academicPeriodId
        : -1
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
        where: {
          academicPeriodId: activeAcademicPeriod
            ? activeAcademicPeriod.academicPeriodId
            : -1
        },

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
        activeAcademicPeriod,
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

          zabeleshki:
            allRole.filter(
              (item) =>
                item.status ===
                'Забелешка'
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
   MOLBI_ARCHIVE_FILTERS_ADMIN_STUDENTS_V1
   ADMIN STUDENT DIRECTORY
========================================================= */

exports.getAdminStudents = async (req, res) => {
  const actor = requireStaff(req, res);
  if (!actor) return;

  if (actor.role !== ROLE.ADMIN || !(await isCurrentAdminAuthorized(actor.userId))) {
    return res.status(403).send('Само администратор има пристап до студентите.');
  }

  const requestedMajor = String(req.query.smer || 'site').trim();
  const currentMajor = FEIT_MAJOR_SET.has(requestedMajor) ? requestedMajor : 'site';
  const currentStudentIndex = String(req.query.studentIndex || '').trim();
  const studentWhere = {};

  if (currentMajor !== 'site') {
    studentWhere.smer = currentMajor;
  }

  if (currentStudentIndex) {
    studentWhere.brIndeks = {
      [Op.iLike]: `%${currentStudentIndex}%`
    };
  }

  try {
    const totalStudents = await Student.count();

    const users = await User.findAll({
      include: [{
        model: Student,
        as: 'studentProfile',
        required: true,
        where: studentWhere
      }],
      order: [
        ['prezime', 'ASC'],
        ['ime', 'ASC'],
        ['email', 'ASC']
      ]
    });

    const students = users.map((user) => ({
      userId: user.userId,
      ime: user.ime || '',
      prezime: user.prezime || '',
      email: user.email || '',
      brIndeks: user.studentProfile ? user.studentProfile.brIndeks : null,
      smer: user.studentProfile ? user.studentProfile.smer : null
    }));

    return res.render('students-admin', {
      title: 'Студенти',
      viewer: actor,
      getRoleLabel,
      convertNameToCyrillic,
      isImpersonating: false,
      students,
      totalStudents,
      majorOptions: FEIT_MAJOR_OPTIONS,
      currentMajor,
      currentStudentIndex,
      hasActiveFilters: currentMajor !== 'site' || Boolean(currentStudentIndex),
      success: req.flash('success'),
      error: req.flash('error')
    });
  } catch (error) {
    console.error('Admin students directory error:', error);
    req.flash('error', 'Неуспешно вчитување на студентите.');
    return res.redirect('/dashboard');
  }
};

exports.getAdminStudentDetail = async (req, res) => {
  const actor = requireStaff(req, res);
  if (!actor) return;

  if (actor.role !== ROLE.ADMIN || !(await isCurrentAdminAuthorized(actor.userId))) {
    return res.status(403).send('Само администратор има пристап до овој преглед.');
  }

  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).send('Невалиден студент.');
  }

  try {
    const target = await User.findByPk(id, {
      include: [{
        model: Student,
        as: 'studentProfile',
        required: true
      }]
    });

    if (!target || !target.studentProfile) {
      return res.status(404).send('Студентот не е пронајден.');
    }

    return res.render('student-admin-detail', {
      title: 'Детали за студент',
      viewer: actor,
      getRoleLabel,
      convertNameToCyrillic,
      isImpersonating: false,
      account: {
        userId: target.userId,
        ime: target.ime || '',
        prezime: target.prezime || '',
        email: target.email || '',
        brIndeks: target.studentProfile.brIndeks || '',
        smer: target.studentProfile.smer || ''
      },
      majorOptions: FEIT_MAJOR_OPTIONS,
      adminCsrfToken: ensureAdminRoleCsrf(req),
      success: req.flash('success'),
      error: req.flash('error')
    });
  } catch (error) {
    console.error('Admin student detail error:', error);
    return res.status(500).send('Неуспешно вчитување на студентот.');
  }
};

exports.updateAdminStudent = async (req, res) => {
  const actor = requireStaff(req, res);
  if (!actor) return;

  if (actor.role !== ROLE.ADMIN || !(await isCurrentAdminAuthorized(actor.userId))) {
    return res.status(403).send('Само администратор може да менува студентски податоци.');
  }

  if (!validAdminRoleCsrf(req)) {
    return res.status(403).send('Невалидна сесија. Освежете ја страницата.');
  }

  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).send('Невалиден студент.');
  }

  const ime = normalizeStaffName(req.body.ime);
  const prezime = normalizeStaffName(req.body.prezime);
  const smer = String(req.body.smer || '').trim();

  if (!validStaffNamePair(ime, prezime)) {
    req.flash('error', 'Внесете валидно име и презиме.');
    return res.redirect(`/dashboard/students/${id}`);
  }

  if (!FEIT_MAJOR_SET.has(smer)) {
    req.flash('error', 'Изберете валидна насока.');
    return res.redirect(`/dashboard/students/${id}`);
  }

  try {
    await User.sequelize.transaction(async (transaction) => {
      const target = await User.findByPk(id, {
        include: [{
          model: Student,
          as: 'studentProfile',
          required: true
        }],
        transaction,
        lock: transaction.LOCK.UPDATE
      });

      if (!target || !target.studentProfile) {
        throw new Error('Студентот не е пронајден.');
      }

      await target.update({ ime, prezime }, { transaction });
      await target.studentProfile.update({ smer }, { transaction });
    });

    if (id === actor.userId && req.session && req.session.user) {
      req.session.user.ime = ime;
      req.session.user.prezime = prezime;
      req.session.user.smer = smer;
    }

    req.flash('success', 'Податоците за студентот се успешно зачувани.');
    return res.redirect('/dashboard/students');
  } catch (error) {
    console.error('Admin student update error:', error);
    req.flash('error', error.message || 'Неуспешно зачувување на студентот.');
    return res.redirect(`/dashboard/students/${id}`);
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


      if (!(await isMolbaInOpenAcademicPeriod(molba))) {
        req.flash('error', 'Оваа молба припаѓа на затворен семестар и е достапна само за преглед.');
        return res.redirect('/dashboard');
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
    const user = requireStudent(req, res);
    if (!user) return;

    try {
      /*
       * Keep brIndeks synchronized even if this browser session existed before
       * the login patch was applied. This never changes Student.smer.
       */
      await syncStudentIndexFromEmail({
        userId: user.userId,
        email: user.email
      });

      const [studentProfile, activeAcademicPeriod] = await Promise.all([
        Student.findOne({ where: { userId: user.userId } }),
        getOpenAcademicPeriod()
      ]);

      if (req.session && req.session.user && studentProfile) {
        req.session.user.brIndeks = studentProfile.brIndeks || null;
        req.session.user.smer = studentProfile.smer || null;
      }

      return res.render('nova-molba', {
        title: 'Нова молба',
        viewer: req.session && req.session.user ? req.session.user : user,
        getRoleLabel,
        convertNameToCyrillic,
        isImpersonating: false,
        studentProfile,
        activeAcademicPeriod,
        majorOptions: FEIT_MAJOR_OPTIONS,
        error: req.flash('error')
      });
    } catch (error) {
      console.error('Load nova molba error:', error);
      req.flash('error', 'Настана грешка при вчитување на формата.');
      return res.redirect('/dashboard');
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
    decodeLegacyUtf8FileName(
      String(file.originalname).replace(/\\/g, '/')
    )
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

const deleteFileQuietly = (fullPath, label = 'file') => {
  if (!fullPath) return;

  try {
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  } catch (error) {
    console.warn(`[Controller] ${label} delete warning:`, error.message);
  }
};

const discardUploadedFile = (file) => {
  if (!file || !file.path) return;
  deleteFileQuietly(path.resolve(file.path), 'uploaded file');
};

exports.postNovaMolba =
  async (
    req,
    res
  ) => {
    const user = requireStudent(req, res);

    if (!user) {
      discardUploadedFile(req.file);
      return;
    }

    try {
      const activeAcademicPeriod = await getOpenAcademicPeriod();

      if (!activeAcademicPeriod) {
        discardUploadedFile(req.file);
        req.flash('error', 'Во моментот нема отворен семестар. Не може да се поднесе нова молба.');
        return res.redirect('/dashboard/nova-molba');
      }

      /* brIndeks is server-controlled; smer is student-selected. */
      await syncStudentIndexFromEmail({
        userId: user.userId,
        email: user.email
      });

      const studentProfile = await Student.findOne({
        where: {
          userId: user.userId
        }
      });

      const cleanIndex = String(studentProfile?.brIndeks || '').trim();

      if (!cleanIndex) {
        discardUploadedFile(req.file);
        req.flash(
          'error',
          'Не може да се утврди бројот на индекс од FEIT email адресата. Одјавете се и најавете се повторно.'
        );
        return res.redirect('/dashboard/nova-molba');
      }

      const {
        naslov,
        ciklus,
        smer,
        description
      } = req.body;

      const existingSmer = String(studentProfile?.smer || '').trim();
      const submittedSmer = String(smer || '').trim();
      const cleanSmer = FEIT_MAJOR_SET.has(existingSmer)
        ? existingSmer
        : submittedSmer;

      if (!FEIT_MAJOR_SET.has(cleanSmer)) {
        discardUploadedFile(req.file);
        req.flash('error', 'Изберете валидна насока.');
        return res.redirect('/dashboard/nova-molba');
      }

      if (!naslov || naslov.trim() === '') {
        discardUploadedFile(req.file);
        req.flash('error', 'Насловот е задолжителен.');
        return res.redirect('/dashboard/nova-molba');
      }

      if (!allowedCiklusi.has(ciklus)) {
        discardUploadedFile(req.file);
        req.flash('error', 'Изберете Прв или Втор циклус на студии.');
        return res.redirect('/dashboard/nova-molba');
      }

      const cleanDescription = String(description || '').trim();
      if (!cleanDescription) {
        discardUploadedFile(req.file);
        req.flash('error', 'Текстот на молбата е задолжителен.');
        return res.redirect('/dashboard/nova-molba');
      }

      if (!req.file) {
        req.flash('error', 'Прикачување PDF документ е задолжително.');
        return res.redirect('/dashboard/nova-molba');
      }

      preserveOriginalStudentPdfName(req.file);

      const relativeUploadPath = toPosixPath(
        path.join(
          getStudentDocumentPath(
            cleanSmer,
            user.ime,
            user.prezime
          ),
          req.file.filename
        )
      );

      /*
       * Allocate the per-student request number atomically.
       * Locking the Student row prevents two simultaneous submissions from
       * receiving the same studentMolbaBroj.
       */
      const createdMolba = await sequelize.transaction(async (transaction) => {
        const lockedStudent = await Student.findOne({
          where: { userId: user.userId },
          transaction,
          lock: transaction.LOCK.UPDATE
        });

        if (!lockedStudent) {
          throw new Error('Student profile not found while allocating request number.');
        }

        const maxExistingNumber = await Molba.max(
          'studentMolbaBroj',
          {
            where: { userId: user.userId },
            transaction
          }
        );

        const nextStudentMolbaBroj =
          Math.max(
            Number(lockedStudent.brojMolbi || 0),
            Number(maxExistingNumber || 0)
          ) + 1;

        const lockedExistingSmer = String(lockedStudent.smer || '').trim();
        if (!FEIT_MAJOR_SET.has(lockedExistingSmer)) {
          lockedStudent.smer = cleanSmer;
        }
        lockedStudent.brojMolbi = nextStudentMolbaBroj;
        await lockedStudent.save({ transaction });

        return Molba.create(
          {
            userId: user.userId,
            studentMolbaBroj: nextStudentMolbaBroj,
            academicPeriodId: activeAcademicPeriod.academicPeriodId,
            naslov: naslov.trim(),
            semestar: activeAcademicPeriod.semestar,
            ucebnaGodina: activeAcademicPeriod.ucebnaGodina,
            ciklus,
            description: cleanDescription,
            status: 'Во процес',
            datum: new Date(),
            arhivskiBroj: null,
            workflowStage: WORKFLOW_STAGE.SUBMITTED,
            sluzhbaFeedback: null,
            prodekanFeedback: null,
            urlPath: relativeUploadPath
          },
          { transaction }
        );
      });

      if (req.session && req.session.user) {
        req.session.user.brIndeks = cleanIndex;
        req.session.user.smer = cleanSmer;
      }

      if (user.email) {
        const studentFullName = `${user.ime} ${user.prezime}`;
        runBackgroundEmail(
          'Molba created',
          () => sendMolbaCreatedEmail(user.email, studentFullName, naslov.trim())
        );
      }

      console.log(
        `[Molba] created globalId=${createdMolba.molbaId} studentNumber=${createdMolba.studentMolbaBroj} userId=${user.userId}`
      );

      req.flash('success', 'Молбата е успешно поднесена.');
      return res.redirect('/dashboard');
    } catch (error) {
      discardUploadedFile(req.file);

      console.error('Create molba error:', error);
      req.flash('error', 'Настана грешка при креирање на молбата.');
      return res.redirect('/dashboard/nova-molba');
    }
  };

/* =========================================================
   POST /dashboard/molba/:id/student-revision

   Student can edit only while the request is explicitly waiting
   for a correction requested by the vice-dean.
========================================================= */
exports.deleteStudentRevisionDocument = async (req, res) => {
  const user = requireStudent(req, res);
  if (!user) return;

  const returnPath = `/dashboard/molba/${req.params.id}`;

  try {
    const molba = await Molba.findOne({
      where: {
        molbaId: req.params.id,
        userId: user.userId
      }
    });

    if (!molba) {
      req.flash('error', 'Молбата не е пронајдена.');
      return res.redirect('/dashboard');
    }

    const period = molba.academicPeriodId
      ? await AcademicPeriod.findByPk(molba.academicPeriodId)
      : null;

    if (!period || period.status !== ACADEMIC_PERIOD_STATUS.OPEN) {
      req.flash('error', 'Молбата е од затворен семестар и повеќе не може да се менува.');
      return res.redirect(returnPath);
    }

    if (molba.status !== 'Забелешка') {
      req.flash('error', 'Документот може да се менува само додека молбата е со статус „Забелешка“.');
      return res.redirect(returnPath);
    }

    if (!molba.urlPath) {
      req.flash('success', 'Молбата веќе нема прикачен PDF документ.');
      return res.redirect(returnPath);
    }

    const oldRelativePath = molba.urlPath;
    const oldFullPath = resolveUploadPath(oldRelativePath);

    molba.urlPath = null;
    await molba.save();

    if (oldFullPath) {
      deleteFileQuietly(oldFullPath, 'student PDF');
    }

    req.flash('success', 'Прикачениот PDF документ е успешно отстранет.');
    return res.redirect(returnPath);
  } catch (error) {
    console.error('Delete student revision document error:', error);
    req.flash('error', 'Настана грешка при отстранување на PDF документот.');
    return res.redirect(returnPath);
  }
};

exports.updateStudentRevision = async (req, res) => {
  const user = requireStudent(req, res);
  if (!user) {
    discardUploadedFile(req.file);
    return;
  }

  const returnPath = `/dashboard/molba/${req.params.id}`;

  try {
    const molba = await Molba.findOne({
      where: {
        molbaId: req.params.id,
        userId: user.userId
      }
    });

    if (!molba) {
      discardUploadedFile(req.file);
      req.flash('error', 'Молбата не е пронајдена.');
      return res.redirect('/dashboard');
    }

    const period = molba.academicPeriodId
      ? await AcademicPeriod.findByPk(molba.academicPeriodId)
      : null;

    if (!period || period.status !== ACADEMIC_PERIOD_STATUS.OPEN) {
      discardUploadedFile(req.file);
      req.flash('error', 'Молбата е од затворен семестар и повеќе не може да се менува.');
      return res.redirect(returnPath);
    }

    if (molba.status !== 'Забелешка') {
      discardUploadedFile(req.file);
      req.flash('error', 'Оваа молба во моментот не е отворена за измена.');
      return res.redirect(returnPath);
    }

    await syncStudentIndexFromEmail({
      userId: user.userId,
      email: user.email
    });

    const studentProfile = await Student.findOne({
      where: {
        userId: user.userId
      }
    });

    const cleanIndex = String(studentProfile?.brIndeks || '').trim();

    if (!cleanIndex) {
      discardUploadedFile(req.file);
      req.flash(
        'error',
        'Не може да се утврди бројот на индекс од FEIT email адресата.'
      );
      return res.redirect(returnPath);
    }

    const {
      naslov,
      ciklus,
      description,
      removeExistingDocument
    } = req.body;

    const cleanNaslov = String(naslov || '').trim();
    const cleanSmer = String(studentProfile?.smer || '').trim();
    const cleanDescription = String(description || '').trim();

    if (!FEIT_MAJOR_SET.has(cleanSmer)) {
      discardUploadedFile(req.file);
      req.flash('error', 'Изберете валидна насока.');
      return res.redirect(returnPath);
    }
    const wantsDocumentRemoval = String(removeExistingDocument || '').trim() === '1';

    if (!cleanNaslov) {
      discardUploadedFile(req.file);
      req.flash('error', 'Насловот е задолжителен.');
      return res.redirect(returnPath);
    }

    if (!allowedCiklusi.has(ciklus)) {
      discardUploadedFile(req.file);
      req.flash('error', 'Изберете Прв или Втор циклус на студии.');
      return res.redirect(returnPath);
    }

    if (!cleanDescription) {
      discardUploadedFile(req.file);
      req.flash('error', 'Текстот на молбата е задолжителен.');
      return res.redirect(returnPath);
    }

    let replacementRelativePath = null;
    if (req.file) {
      preserveOriginalStudentPdfName(req.file);
      replacementRelativePath = toPosixPath(
        path.join(
          getStudentDocumentPath(cleanSmer, user.ime, user.prezime),
          req.file.filename
        )
      );
    }

    const oldRelativePath = molba.urlPath;
    let nextRelativePath = oldRelativePath;

    if (wantsDocumentRemoval) nextRelativePath = null;
    if (replacementRelativePath) nextRelativePath = replacementRelativePath;

    if (req.session && req.session.user) {
      req.session.user.brIndeks = cleanIndex;
      req.session.user.smer = cleanSmer;
    }

    molba.naslov = cleanNaslov;
    // semestar / ucebnaGodina / brIndeks / smer are system-controlled.
    molba.ciklus = ciklus;
    molba.description = cleanDescription;
    molba.urlPath = nextRelativePath;
    molba.workflowStage = WORKFLOW_STAGE.SERVICE_REVIEWED;

    await molba.save();

    if ((wantsDocumentRemoval || replacementRelativePath) && oldRelativePath) {
      const oldFullPath = resolveUploadPath(oldRelativePath);
      const newFullPath = nextRelativePath ? resolveUploadPath(nextRelativePath) : null;
      if (oldFullPath && (!newFullPath || oldFullPath !== newFullPath)) {
        deleteFileQuietly(oldFullPath, 'old student PDF');
      }
    }

    req.flash('success', 'Промените се успешно зачувани и молбата е повторно испратена до Продекан.');
    return res.redirect('/dashboard');
  } catch (error) {
    discardUploadedFile(req.file);
    console.error('Student revision error:', error);
    req.flash('error', 'Настана грешка при зачувување на измените.');
    return res.redirect(returnPath);
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
      const isClosedAcademicPeriod = Boolean(
        molba.academicPeriod &&
        molba.academicPeriod.status === ACADEMIC_PERIOD_STATUS.CLOSED
      );

      if (
        !isStudentRole(user.role) &&
        !isClosedAcademicPeriod &&
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


      const canArchiveNumber =
        !isClosedAcademicPeriod &&
        user.role === ROLE.ARHIVA;


      const canServiceReview =
        !isClosedAcademicPeriod &&
        user.role ===
          ROLE.STUDENTSKA_SLUZHBA &&

        stage ===
          WORKFLOW_STAGE.ARCHIVED;


      const canProdekanDecide =
        !isClosedAcademicPeriod &&
        user.role ===
          ROLE.PRODEKAN &&

        stage ===
          WORKFLOW_STAGE.SERVICE_REVIEWED;


      // MOLBI_INLINE_REVISION_UI_V2
      const canStudentRevise =
        !isClosedAcademicPeriod &&
        isStudentRole(user.role) &&
        molba.status === 'Забелешка';


      const canGenerateMolbaPdf =
        !isClosedAcademicPeriod &&
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
            `Молба #${molba.studentMolbaBroj || molba.molbaId}`,

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

          canStudentRevise,

          majorOptions: FEIT_MAJOR_OPTIONS,

          getReadableStoredFileName,

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


      if (!(await isMolbaInOpenAcademicPeriod(molba))) {
        req.flash('error', 'Оваа молба припаѓа на затворен семестар и е достапна само за преглед.');
        return res.redirect('/dashboard');
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
        'Само Продеканот може да донесе одлука или да побара измена.'
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
       * Prodekan can either make a final decision or request a revision.
       */
      if (
        ![
          'Забелешка',
          'Одобрена',
          'Одбиена'
        ].includes(
          status
        )
      ) {
        req.flash(
          'error',
          'Изберете Забелешка, Одобрена или Одбиена.'
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


      if (!(await isMolbaInOpenAcademicPeriod(molba))) {
        req.flash('error', 'Оваа молба припаѓа на затворен семестар и е достапна само за преглед.');
        return res.redirect('/dashboard');
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


      const cleanFeedback = String(feedback || '').trim();
      const cleanProdekanFeedback = String(prodekanFeedback || '').trim();

      if (status === 'Забелешка' && !cleanFeedback) {
        req.flash(
          'error',
          'За статус „Забелешка“ внесете забелешка со измените што треба да ги направи студентот.'
        );

        return res.redirect(`/dashboard/molba/${req.params.id}`);
      }

      molba.status = status;

      /*
       * feedback is the student-facing text. It remains editable on the next
       * vice-dean review, so it can be cleared before approval or rewritten
       * into a concise rejection reason before the final PDF is generated.
       */
      molba.feedback = cleanFeedback || null;

      /* Internal note to Student Service. */
      molba.prodekanFeedback = cleanProdekanFeedback || null;

      if (status === 'Забелешка') {
        molba.workflowStage = WORKFLOW_STAGE.STUDENT_REVISION;
        molba.decisionAt = null;
        molba.decisionByUserId = null;
      } else {
        molba.workflowStage = WORKFLOW_STAGE.DECIDED;

        // The source of truth is the successful final-decision action.
        molba.decisionAt = new Date();
        molba.decisionByUserId = user.userId;
      }

      await molba.save();

      req.flash(
        'success',
        status === 'Забелешка'
          ? 'Забелешката е зачувана. Молбата е вратена кај студентот за измена.'
          : 'Одлуката е успешно зачувана и молбата е испратена до Студентската служба.'
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


      if (!(await isMolbaInOpenAcademicPeriod(molba))) {
        req.flash('error', 'Оваа молба припаѓа на затворен семестар и е достапна само за преглед.');
        return res.redirect('/dashboard');
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
        getReadableStoredFileName(molba.urlPath) || path.basename(fullPath)
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

exports.editMolbaByStudent = async (req, res) => {
  try {
    const { id } = req.params;
    const molba = await Molba.findByPk(id);

    if (!molba) {
      req.flash('error_msg', 'Молбата не е пронајдена.');
      return res.redirect('/dashboard');
    }

    if (req.user.userId !== molba.userId) {
      req.flash('error_msg', 'Немате овластување за да ја менувате оваа молба.');
      return res.redirect('/dashboard');
    }

    if (molba.status !== 'Забелешка') {
      req.flash('error_msg', 'Молбата не може да се менува во оваа фаза.');
      return res.redirect(`/molbi/${id}`);
    }

    molba.naslov = req.body.naslov || molba.naslov;
    molba.description = req.body.description || molba.description;
    molba.semestar = req.body.semestar || molba.semestar;
    molba.ucebna_godina = req.body.ucebna_godina || molba.ucebna_godina;
    molba.smer = req.body.smer || molba.smer;

    if (req.file) {
      molba.url_path = req.file.path;
    }

    molba.status = 'Во процес';
    molba.workflow_stage = 'SERVICE_REVIEWED';

    await molba.save();

    req.flash('success_msg', 'Успешно ја изменивте молбата. Испратена е повторно до Продеканот.');
    res.redirect(`/molbi/${id}`);
  } catch (err) {
    console.error(err);
    req.flash('error_msg', 'Грешка при измена на молбата.');
    res.redirect('/dashboard');
  }
};
