const bcrypt = require('bcryptjs');

const {
  User,
  Student,
  Role,
  UserRole
} = require('../models');

const {
  ROLE,
  resolveRoleContexts
} = require('../utils/roleHelpers');

const {
  verifyPop3Credentials
} = require('../utils/pop3AuthService');

const {
  isEntraConfigured,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  verifyIdToken,
  generateStateToken
} = require('../config/entraAuth');


/* =========================================================
   CONSTANTS
========================================================= */

const ADMINISTRATIVE_ROLES = [
  ROLE.ADMIN,
  ROLE.STUDENTSKA_SLUZHBA,
  ROLE.PRODEKAN,
  ROLE.ARHIVA
];


/* =========================================================
   USER / SESSION HELPERS
========================================================= */

const isLoggedIn = (req) => {
  return !!req.session?.user;
};


/**
 * Сите roles се земаат преку M:N user_roles.
 * users.roleId повеќе не постои.
 */
const userRoleIncludes = [
  {
    model: Student,
    as: 'studentProfile',
    required: false
  },
  {
    model: Role,
    as: 'roles',
    required: false,
    through: {
      attributes: []
    }
  }
];


/**
 * Повторно го вчитува user-от со сите roles.
 */
const reloadUserWithRoles = async (userId) => {
  return User.findOne({
    where: {
      userId
    },
    include: userRoleIncludes
  });
};


const normalizeEmail = (email) => {
  return String(email || '')
    .trim()
    .toLowerCase();
};


const userHasRole = (user, roleName) => {
  return resolveRoleContexts(user).some(
    (roleContext) =>
      roleContext.role === roleName
  );
};


const isStaffUser = (user) => {
  return resolveRoleContexts(user).some(
    (roleContext) =>
      ADMINISTRATIVE_ROLES.includes(
        roleContext.role
      )
  );
};


/**
 * Session структура.
 *
 * loginContext:
 * - student
 * - administrative
 *
 * authMethod:
 * - microsoft
 * - feit_pop3
 * - local
 */
const buildSessionUser = (
  user,
  loginContext,
  authMethod
) => {
  const roleContexts =
    resolveRoleContexts(user);

  return {
    userId: user.userId,
    ime: user.ime,
    prezime: user.prezime,
    email: user.email,

    brIndeks:
      user.studentProfile?.brIndeks || null,

    roles: roleContexts.map(
      (roleContext) => ({
        roleId: roleContext.roleId,
        role: roleContext.role,
        roleLabel: roleContext.roleLabel,
        roleTip: roleContext.roleTip
      })
    ),

    activeRole: null,
    activeRoleId: null,
    activeRoleLabel: null,
    activeRoleTip: null,

    /*
     * Compatibility со постоечкиот dashboard код.
     * Овие вредности ќе бидат активната улога.
     */
    role: null,
    roleId: null,
    roleLabel: null,
    roleTip: null,

    hasMultipleRoles:
      roleContexts.length > 1,

    /*
     * Како е отворена оваа session.
     */
    loginContext,

    /*
     * Со кој authentication механизам
     * е потврден идентитетот.
     */
    authMethod,

    /*
     * DB provider го чуваме само
     * како информација.
     */
    authProvider:
      user.provider || 'local',

    authServer:
      user.authServer || 'smail'
  };
};


/**
 * Активира role која веќе е доделена
 * на корисникот.
 */
const activateRole = (
  sessionUser,
  roleName
) => {
  if (
    !sessionUser ||
    !Array.isArray(sessionUser.roles)
  ) {
    return false;
  }

  const selectedRole =
    sessionUser.roles.find(
      (roleItem) =>
        roleItem.role === roleName
    );

  if (!selectedRole) {
    return false;
  }

  sessionUser.activeRole =
    selectedRole.role;

  sessionUser.activeRoleId =
    selectedRole.roleId;

  sessionUser.activeRoleLabel =
    selectedRole.roleLabel;

  sessionUser.activeRoleTip =
    selectedRole.roleTip;


  /*
   * Compatibility aliases.
   */
  sessionUser.role =
    selectedRole.role;

  sessionUser.roleId =
    selectedRole.roleId;

  sessionUser.roleLabel =
    selectedRole.roleLabel;

  sessionUser.roleTip =
    selectedRole.roleTip;

  return true;
};


/**
 * Завршување на административна најава.
 *
 * Student role се игнорира.
 *
 * 1 staff role -> директно dashboard
 * 2+ staff roles -> select-role
 */
const finishAdministrativeLogin = (
  req,
  res,
  user,
  authMethod
) => {
  const sessionUser =
    buildSessionUser(
      user,
      'administrative',
      authMethod
    );

  const administrativeRoles =
    sessionUser.roles.filter(
      (roleItem) =>
        ADMINISTRATIVE_ROLES.includes(
          roleItem.role
        )
    );

  if (!administrativeRoles.length) {
    req.flash(
      'error',
      'Корисникот нема доделена административна улога.'
    );

    return res.redirect(
      '/admin-login'
    );
  }

  req.session.user =
    sessionUser;


  /*
   * Една административна role:
   * нема потреба од избор.
   */
  if (administrativeRoles.length === 1) {
    activateRole(
      req.session.user,
      administrativeRoles[0].role
    );

    return res.redirect(
      '/dashboard'
    );
  }


  /*
   * Повеќе административни roles.
   */
  return res.redirect(
    '/select-role'
  );
};


const flashAndRedirect = (
  req,
  res,
  redirectPath,
  message
) => {
  req.flash(
    'error',
    message
  );

  return res.redirect(
    redirectPath
  );
};


/* =========================================================
   EMAIL DOMAIN HELPERS
========================================================= */

const getUserEmailFromPayload = (
  payload
) => {
  return (
    payload.preferred_username ||
    payload.email ||
    payload.upn ||
    null
  );
};


const getAllowedEntraDomains = () => {
  const raw =
    process.env.ENTRA_ALLOWED_EMAIL_DOMAINS ||
    '';

  return raw
    .split(',')
    .map(
      (value) =>
        value.trim().toLowerCase()
    )
    .filter(Boolean);
};


const isAllowedStudentEmailDomain = (
  email
) => {
  const allowedDomains =
    getAllowedEntraDomains();

  if (!allowedDomains.length) {
    return true;
  }

  const domain =
    (email.split('@')[1] || '')
      .toLowerCase();

  return allowedDomains.includes(
    domain
  );
};


const getAllowedStaffEmailDomains = () => {
  const raw =
    process.env.FEIT_STAFF_ALLOWED_EMAIL_DOMAINS ||
    process.env.FEIT_ALLOWED_EMAIL_DOMAINS ||
    'feit.ukim.edu.mk';

  return raw
    .split(',')
    .map(
      (value) =>
        value.trim().toLowerCase()
    )
    .filter(Boolean);
};


const isAllowedStaffEmailDomain = (
  email
) => {
  const allowedDomains =
    getAllowedStaffEmailDomains();

  const domain =
    (email.split('@')[1] || '')
      .toLowerCase();

  if (!domain) {
    return false;
  }

  return allowedDomains.includes(
    domain
  );
};


/* =========================================================
   LOCAL / ADMIN PASSWORD LOGIN
========================================================= */

const handlePasswordLogin = async (
  req,
  res,
  isAdminLogin
) => {
  const redirectPath =
    isAdminLogin
      ? '/admin-login'
      : '/login';

  try {
    const email =
      normalizeEmail(req.body.email);

    const password =
      req.body.password;


    if (!email || !password) {
      return flashAndRedirect(
        req,
        res,
        redirectPath,
        'Внесете email и лозинка.'
      );
    }


    /* =====================================================
       ADMINISTRATIVE LOGIN
    ===================================================== */

    if (isAdminLogin) {

      /*
       * ВАЖНО:
       * НЕ филтрираме по provider.
       *
       * Истиот email може да биде:
       * provider = microsoft
       *
       * а сепак да се најавува административно
       * преку FEIT POP3.
       */
      const user =
        await User.findOne({
          where: {
            email
          },
          include:
            userRoleIncludes
        });


      if (!user) {
        return flashAndRedirect(
          req,
          res,
          '/admin-login',
          'Невалиден email или лозинка.'
        );
      }


      if (!isStaffUser(user)) {
        return flashAndRedirect(
          req,
          res,
          '/admin-login',
          'Немате доделена административна улога.'
        );
      }


      /*
       * Специјален local Admin.
       */
      if (user.provider === 'local') {

        if (
          !userHasRole(
            user,
            ROLE.ADMIN
          )
        ) {
          return flashAndRedirect(
            req,
            res,
            '/admin-login',
            'Немате дозвола за локална административна најава.'
          );
        }


        if (!user.password) {
          return flashAndRedirect(
            req,
            res,
            '/admin-login',
            'Корисникот нема локална лозинка.'
          );
        }


        const isMatch =
          await bcrypt.compare(
            password,
            user.password
          );


        if (!isMatch) {
          return flashAndRedirect(
            req,
            res,
            '/admin-login',
            'Невалиден email или лозинка.'
          );
        }


        return finishAdministrativeLogin(
          req,
          res,
          user,
          'local'
        );
      }


      /*
       * Сите FEIT accounts:
       *
       * provider може да биде:
       * - microsoft
       * - feit_pop3
       *
       * Но ако се најавуваат преку
       * /admin-login, authentication
       * е FEIT POP3.
       */
      if (
        !isAllowedStaffEmailDomain(
          email
        )
      ) {
        return flashAndRedirect(
          req,
          res,
          '/admin-login',
          'Дозволени се само FEIT email адреси за оваа најава.'
        );
      }


      const isValidFeitLogin =
        await verifyPop3Credentials(
          email,
          password,
          user.authServer || 'smail'
        );


      if (!isValidFeitLogin) {
        return flashAndRedirect(
          req,
          res,
          '/admin-login',
          'Невалиден FEIT email или лозинка.'
        );
      }


      return finishAdministrativeLogin(
        req,
        res,
        user,
        'feit_pop3'
      );
    }


    /* =====================================================
       LEGACY LOCAL STUDENT LOGIN
    ===================================================== */

    const user =
      await User.findOne({
        where: {
          email,
          provider: 'local'
        },
        include:
          userRoleIncludes
      });


    if (!user) {
      return flashAndRedirect(
        req,
        res,
        '/login',
        'Невалиден email или лозинка.'
      );
    }


    if (
      !userHasRole(
        user,
        ROLE.STUDENT
      )
    ) {
      return flashAndRedirect(
        req,
        res,
        '/login',
        'Оваа најава е дозволена само за студенти.'
      );
    }


    if (!user.password) {
      return flashAndRedirect(
        req,
        res,
        '/login',
        'Корисникот нема локална лозинка.'
      );
    }


    const isMatch =
      await bcrypt.compare(
        password,
        user.password
      );


    if (!isMatch) {
      return flashAndRedirect(
        req,
        res,
        '/login',
        'Невалиден email или лозинка.'
      );
    }


    req.session.user =
      buildSessionUser(
        user,
        'student',
        'local'
      );


    activateRole(
      req.session.user,
      ROLE.STUDENT
    );


    return res.redirect(
      '/dashboard'
    );

  } catch (error) {

    console.error(
      'Password login error:',
      error
    );


    return flashAndRedirect(
      req,
      res,
      redirectPath,
      'Настана грешка при најава.'
    );
  }
};


/* =========================================================
   GET /login
========================================================= */

exports.getLogin = (
  req,
  res
) => {

  /*
   * Ако веќе сме најавени како Student,
   * оди на Student dashboard.
   *
   * Ако сме административно најавени,
   * сепак дозволуваме да се отвори
   * student login page за Entra login.
   */
  if (
    isLoggedIn(req) &&
    req.session.user.loginContext ===
      'student'
  ) {
    return res.redirect(
      '/dashboard'
    );
  }


  return res.render(
    'login',
    {
      title:
        'Најава',

      error:
        req.flash('error'),

      success:
        req.flash('success'),

      entraEnabled:
        isEntraConfigured()
    }
  );
};


/* =========================================================
   GET /admin-login
========================================================= */

exports.getAdminLogin = (
  req,
  res
) => {

  /*
   * Ако веќе сме administrative,
   * не бараме повторна најава.
   *
   * Ако сме Student, дозволуваме
   * да се отвори admin-login
   * за FEIT re-authentication.
   */
  if (
    isLoggedIn(req) &&
    req.session.user.loginContext ===
      'administrative'
  ) {

    if (
      !req.session.user.activeRole
    ) {
      return res.redirect(
        '/select-role'
      );
    }


    return res.redirect(
      '/dashboard'
    );
  }


  return res.render(
    'admin-login',
    {
      title:
        'Администраторска Најава',

      error:
        req.flash('error'),

      success:
        req.flash('success')
    }
  );
};


/* =========================================================
   POST /login
========================================================= */

exports.postLogin = async (
  req,
  res
) => {
  return handlePasswordLogin(
    req,
    res,
    false
  );
};


/* =========================================================
   POST /admin-login
========================================================= */

exports.postAdminLogin = async (
  req,
  res
) => {
  return handlePasswordLogin(
    req,
    res,
    true
  );
};


/* =========================================================
   SELECT ROLE
========================================================= */

exports.getSelectRole = (
  req,
  res
) => {

  if (
    !req.session?.user
  ) {
    return res.redirect(
      '/admin-login'
    );
  }


  /*
   * КЛУЧНА SECURITY ПРОВЕРКА:
   *
   * Student што е најавен преку Entra
   * НЕ смее да отвори /select-role
   * и да активира staff role без FEIT password.
   */
  if (
    req.session.user.loginContext !==
    'administrative'
  ) {
    return res.redirect(
      '/dashboard'
    );
  }


  const administrativeRoles =
    (req.session.user.roles || [])
      .filter(
        (roleItem) =>
          ADMINISTRATIVE_ROLES.includes(
            roleItem.role
          )
      );


  if (!administrativeRoles.length) {
    req.flash(
      'error',
      'Немате доделена административна улога.'
    );

    return res.redirect(
      '/admin-login'
    );
  }


  if (
    administrativeRoles.length === 1
  ) {
    activateRole(
      req.session.user,
      administrativeRoles[0].role
    );

    return res.redirect(
      '/dashboard'
    );
  }


  return res.render(
    'select-role',
    {
      title:
        'Избор на улога',

      user: {
        ...req.session.user,
        roles:
          administrativeRoles
      },

      error:
        req.flash('error')
    }
  );
};


exports.postSelectRole = (
  req,
  res
) => {

  if (
    !req.session?.user
  ) {
    return res.redirect(
      '/admin-login'
    );
  }


  /*
   * Само session потврдена преку
   * administrative login смее
   * да менува administrative role.
   */
  if (
    req.session.user.loginContext !==
    'administrative'
  ) {
    return res.redirect(
      '/dashboard'
    );
  }


  const selectedRole =
    String(
      req.body.role || ''
    )
      .trim()
      .toLowerCase();


  if (
    !ADMINISTRATIVE_ROLES.includes(
      selectedRole
    )
  ) {
    req.flash(
      'error',
      'Изберете валидна административна улога.'
    );

    return res.redirect(
      '/select-role'
    );
  }


  /*
   * Дополнителна проверка:
   * role мора навистина да му биде
   * доделена на user-от.
   */
  const activated =
    activateRole(
      req.session.user,
      selectedRole
    );


  if (!activated) {
    req.flash(
      'error',
      'Избраната улога не Ви е доделена.'
    );

    return res.redirect(
      '/select-role'
    );
  }


  return res.redirect(
    '/dashboard'
  );
};


/* =========================================================
   MICROSOFT ENTRA LOGIN
========================================================= */

exports.startMicrosoftLogin = (
  req,
  res
) => {

  if (!isEntraConfigured()) {
    req.flash(
      'error',
      'Microsoft Entra не е конфигуриран во .env.'
    );

    return res.redirect(
      '/login'
    );
  }


  const state =
    generateStateToken();

  const nonce =
    generateStateToken();


  req.session.entraAuth = {
    state,
    nonce
  };


  return res.redirect(
    buildAuthorizeUrl(
      state,
      nonce
    )
  );
};


/* =========================================================
   MICROSOFT ENTRA CALLBACK
========================================================= */

exports.microsoftCallback = async (
  req,
  res
) => {

  try {

    if (!isEntraConfigured()) {
      req.flash(
        'error',
        'Microsoft Entra не е конфигуриран.'
      );

      return res.redirect(
        '/login'
      );
    }


    const {
      code,
      state,
      error,
      error_description:
        errorDescription
    } = req.query;


    if (error) {
      req.flash(
        'error',
        `Entra login не успеа: ${
          errorDescription || error
        }`
      );

      return res.redirect(
        '/login'
      );
    }


    const savedAuth =
      req.session.entraAuth;


    if (
      !savedAuth ||
      !savedAuth.state ||
      !savedAuth.nonce ||
      !state ||
      savedAuth.state !== state
    ) {
      req.flash(
        'error',
        'Невалидна Entra сесија. Обидете се повторно.'
      );

      return res.redirect(
        '/login'
      );
    }


    delete req.session.entraAuth;


    if (!code) {
      req.flash(
        'error',
        'Не е добиен authorization code од Entra.'
      );

      return res.redirect(
        '/login'
      );
    }


    const tokenResponse =
      await exchangeCodeForTokens(
        code
      );


    const payload =
      await verifyIdToken(
        tokenResponse.id_token,
        savedAuth.nonce
      );


    const providerId =
      payload.oid;


    const email =
      normalizeEmail(
        getUserEmailFromPayload(
          payload
        )
      );


    if (
      !providerId ||
      !email
    ) {
      req.flash(
        'error',
        'Недостигаат OID или email од Entra профилот.'
      );

      return res.redirect(
        '/login'
      );
    }


    if (
      !isAllowedStudentEmailDomain(
        email
      )
    ) {
      req.flash(
        'error',
        'Овој email домен не е дозволен за Entra најава.'
      );

      return res.redirect(
        '/login'
      );
    }


    /*
     * 1. Прво пробуваме по Microsoft OID.
     *
     * НЕ ограничуваме provider = microsoft,
     * затоа што account-от можеби претходно
     * бил feit_pop3.
     */
    let user =
      await User.findOne({
        where: {
          providerId
        },
        include:
          userRoleIncludes
      });


    /*
     * 2. Ако нема match по OID,
     * бараме само по email.
     *
     * Ова е клучно за:
     *
     * kti...@feit...
     * provider = feit_pop3
     * roles = Student + Arhiva
     */
    if (!user) {
      user =
        await User.findOne({
          where: {
            email
          },
          include:
            userRoleIncludes
        });
    }


    /* =====================================================
       EXISTING USER
    ===================================================== */

    if (user) {

      /*
       * Entra login е дозволен само
       * ако user има Student role.
       *
       * Arhiva/Sluzhba/etc. не пречат.
       */
      if (
        !userHasRole(
          user,
          ROLE.STUDENT
        )
      ) {
        req.flash(
          'error',
          'Microsoft Entra најавата е дозволена само за корисници со Student улога.'
        );

        return res.redirect(
          '/login'
        );
      }


      /*
       * Го врзуваме Microsoft OID
       * со постоечкиот account.
       *
       * provider станува microsoft.
       *
       * Ова НЕ го спречува admin login,
       * затоа што admin login повеќе
       * не филтрира по provider.
       */
      if (
        user.provider !== 'microsoft' ||
        user.providerId !== providerId
      ) {
        await user.update({
          provider:
            'microsoft',

          providerId
        });
      }


      user =
        await reloadUserWithRoles(
          user.userId
        );
    }


    /* =====================================================
       NEW STUDENT
    ===================================================== */

    if (!user) {

      const studentRole =
        await Role.findOne({
          where: {
            tip: 'Student'
          }
        });


      if (!studentRole) {
        req.flash(
          'error',
          'Во системот не постои Student улога.'
        );

        return res.redirect(
          '/login'
        );
      }


      const fullName =
        payload.name || '';


      const nameParts =
        fullName
          .trim()
          .split(/\s+/);


      const ime =
        nameParts[0] ||
        'Студент';


      const prezime =
        nameParts
          .slice(1)
          .join(' ') ||
        'Профил';


      user =
        await User.create({
          ime,
          prezime,
          email,

          password:
            null,

          provider:
            'microsoft',

          providerId,

          authServer:
            'smail'
        });


      await UserRole.create({
        userId:
          user.userId,

        roleId:
          studentRole.roleId
      });


      await Student.create({
        userId:
          user.userId,

        brIndeks:
          null,

        smer:
          null
      });


      user =
        await reloadUserWithRoles(
          user.userId
        );
    }


    /* =====================================================
       FINAL STUDENT VALIDATION
    ===================================================== */

    if (
      !userHasRole(
        user,
        ROLE.STUDENT
      )
    ) {
      req.flash(
        'error',
        'Корисникот нема Student улога.'
      );

      return res.redirect(
        '/login'
      );
    }


    /*
     * Осигуруваме Student profile.
     */
    if (!user.studentProfile) {

      await Student.findOrCreate({
        where: {
          userId:
            user.userId
        },

        defaults: {
          brIndeks:
            null,

          smer:
            null
        }
      });


      user =
        await reloadUserWithRoles(
          user.userId
        );
    }


    /*
     * Microsoft login:
     *
     * без разлика дали user има
     * Student + Arhiva + Sluzhba...
     *
     * активната role е САМО Student.
     */
    req.session.user =
      buildSessionUser(
        user,
        'student',
        'microsoft'
      );


    const activated =
      activateRole(
        req.session.user,
        ROLE.STUDENT
      );


    if (!activated) {
      req.flash(
        'error',
        'Не може да се активира студентската улога.'
      );

      return res.redirect(
        '/login'
      );
    }


    return res.redirect(
      '/dashboard'
    );

  } catch (error) {

    console.error(
      'Microsoft callback error:',
      error
    );


    req.flash(
      'error',
      'Настана грешка при Microsoft Entra најава.'
    );


    return res.redirect(
      '/login'
    );
  }
};


/* =========================================================
   LOGOUT
========================================================= */

exports.logout = (
  req,
  res
) => {

  const loginContext =
    req.session?.user?.loginContext ||
    null;


  const redirectPath =
    loginContext === 'administrative'
      ? '/admin-login'
      : '/login';


  req.session.destroy(
    (err) => {

      if (err) {
        console.error(
          'Logout error:',
          err
        );
      }


      res.clearCookie(
        'connect.sid'
      );


      return res.redirect(
        redirectPath
      );
    }
  );
};