const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');

const {
  User,
  Student,
  Role
} = require('../models');

const { resolveRoleContext, isStudentRole } = require('../utils/roleHelpers');
const { verifyPop3Credentials } = require('../utils/pop3AuthService');

const {
  isEntraConfigured,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  verifyIdToken,
  generateStateToken
} = require('../config/entraAuth');

const isLoggedIn = (req) => req.session && !!req.session.user;

const userRoleIncludes = [
  { model: Student, as: 'studentProfile', required: false },
  { model: Role, as: 'role', required: false }
];

const ADMIN_ROLE_NAMES = ['admin', 'админ'];

const STUDENT_ROLE_NAMES = ['student', 'студент'];

const STAFF_ROLE_NAMES = [
  'sluzhba',
  'служба',
  'studentska_sluzhba',
  'студентска служба',
  'prodekan',
  'продекан',
  'arhiva',
  'архива'
];

const normalizeEmail = (email) => {
  return String(email || '').trim().toLowerCase();
};

const normalizeRoleName = (roleName) => {
  return String(roleName || '').trim().toLowerCase();
};

const getRoleCandidates = (user) => {
  const roleContext = resolveRoleContext(user) || {};

  return [
    roleContext.role,
    roleContext.roleLabel,
    user?.role?.tip
  ]
    .map(normalizeRoleName)
    .filter(Boolean);
};

const hasAnyRole = (user, allowedRoles) => {
  const roleCandidates = getRoleCandidates(user);
  return roleCandidates.some((role) => allowedRoles.includes(role));
};

const isAdminUser = (user) => {
  return hasAnyRole(user, ADMIN_ROLE_NAMES);
};

const isStudentUser = (user) => {
  return hasAnyRole(user, STUDENT_ROLE_NAMES);
};

const isStaffUser = (user) => {
  return hasAnyRole(user, STAFF_ROLE_NAMES);
};

const getPasswordLoginRedirectPath = (req) => {
  const originalUrl = `${req.originalUrl || ''} ${req.path || ''}`;
  const referer = req.get('referer') || '';

  if (originalUrl.includes('admin-login') || referer.includes('/admin-login')) {
    return '/admin-login';
  }

  return '/login';
};

const flashAndRedirect = (req, res, redirectPath, message) => {
  req.flash('error', message);
  return res.redirect(redirectPath);
};

const buildSessionUser = (user) => {
  const roleContext = resolveRoleContext(user);

  return {
    userId: user.userId,
    ime: user.ime,
    prezime: user.prezime,
    brIndeks: roleContext.brIndeks,
    email: user.email,
    roleId: roleContext.roleId,
    role: roleContext.role,
    roleLabel: roleContext.roleLabel,
    authProvider: user.provider || 'local',
    authServer: user.authServer || 'smail'
  };
};

const getUserEmailFromPayload = (payload) => {
  return payload.preferred_username || payload.email || payload.upn || null;
};

const getAllowedEntraDomains = () => {
  const raw = process.env.ENTRA_ALLOWED_EMAIL_DOMAINS || '';

  return raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
};

const isAllowedStudentEmailDomain = (email) => {
  const allowedDomains = getAllowedEntraDomains();

  if (!allowedDomains.length) return true;

  const domain = (email.split('@')[1] || '').toLowerCase();

  return allowedDomains.includes(domain);
};

const getAllowedStaffEmailDomains = () => {
  const raw =
    process.env.FEIT_STAFF_ALLOWED_EMAIL_DOMAINS ||
    process.env.FEIT_ALLOWED_EMAIL_DOMAINS ||
    'feit.ukim.edu.mk';

  return raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
};

const isAllowedStaffEmailDomain = (email) => {
  const allowedDomains = getAllowedStaffEmailDomains();
  const domain = (email.split('@')[1] || '').toLowerCase();

  if (!domain) return false;

  return allowedDomains.includes(domain);
};

const handlePasswordLogin = async (req, res) => {
  const redirectPath = getPasswordLoginRedirectPath(req);
  const isAdminLogin = redirectPath === '/admin-login';

  try {
    const email = normalizeEmail(req.body.email);
    const password = req.body.password;

    if (!email || !password) {
      return flashAndRedirect(
        req,
        res,
        redirectPath,
        'Внесете email и лозинка.'
      );
    }

    const user = await User.findOne({
      where: isAdminLogin
        ? {
            email,
            provider: {
              [Op.in]: ['local', 'feit_pop3']
            }
          }
        : {
            email,
            provider: 'local'
          },
      include: userRoleIncludes
    });

    if (!user) {
      return flashAndRedirect(
        req,
        res,
        redirectPath,
        'Невалиден email или лозинка.'
      );
    }

    const roleContext = resolveRoleContext(user);

    if (!roleContext.role) {
      return flashAndRedirect(
        req,
        res,
        redirectPath,
        'Корисникот нема валидна улога во системот.'
      );
    }

    if (isStudentUser(user) || user.provider === 'microsoft') {
      return flashAndRedirect(
        req,
        res,
        '/login',
        'Студентите се најавуваат преку Microsoft Entra копчето.'
      );
    }

    if (user.provider === 'local') {
      if (!isAdminUser(user)) {
        return flashAndRedirect(
          req,
          res,
          redirectPath,
          'Немате дозвола за локална административна најава.'
        );
      }

      if (!user.password) {
        return flashAndRedirect(
          req,
          res,
          redirectPath,
          'Admin корисникот нема локална лозинка.'
        );
      }

      const isMatch = await bcrypt.compare(password, user.password);

      if (!isMatch) {
        return flashAndRedirect(
          req,
          res,
          redirectPath,
          'Невалиден email или лозинка.'
        );
      }

      req.session.user = buildSessionUser(user);

      return res.redirect('/dashboard');
    }

    if (user.provider === 'feit_pop3') {
      if (!isAdminUser(user) && !isStaffUser(user)) {
        return flashAndRedirect(
          req,
          res,
          redirectPath,
          'Немате дозвола за административна најава.'
        );
      }

      if (!isAllowedStaffEmailDomain(email)) {
        return flashAndRedirect(
          req,
          res,
          redirectPath,
          'Дозволени се само FEIT email адреси за оваа најава.'
        );
      }

      const isValidFeitLogin = await verifyPop3Credentials(
        email,
        password,
        user.authServer || 'smail'
      );

      if (!isValidFeitLogin) {
        return flashAndRedirect(
          req,
          res,
          redirectPath,
          'Невалиден FEIT email или лозинка.'
        );
      }

      req.session.user = buildSessionUser(user);

      return res.redirect('/dashboard');
    }

    return flashAndRedirect(
      req,
      res,
      redirectPath,
      'Овој корисник нема валиден начин на најава.'
    );
  } catch (error) {
    console.error('Password login error:', error);

    return flashAndRedirect(
      req,
      res,
      redirectPath,
      'Настана грешка при најава.'
    );
  }
};

// GET /login
exports.getLogin = (req, res) => {
  if (isLoggedIn(req)) return res.redirect('/dashboard');

  res.render('login', {
    title: 'Најава',
    error: req.flash('error'),
    success: req.flash('success'),
    entraEnabled: isEntraConfigured()
  });
};

// GET /admin-login
exports.getAdminLogin = (req, res) => {
  if (isLoggedIn(req)) return res.redirect('/dashboard');

  res.render('admin-login', {
    title: 'Администраторска Најава',
    error: req.flash('error'),
    success: req.flash('success')
  });
};

// POST /login
exports.postLogin = async (req, res) => {
  return handlePasswordLogin(req, res);
};

// POST /admin-login
exports.postAdminLogin = async (req, res) => {
  return handlePasswordLogin(req, res);
};

// GET /auth/microsoft
exports.startMicrosoftLogin = (req, res) => {
  if (!isEntraConfigured()) {
    req.flash('error', 'Microsoft Entra не е конфигуриран во .env.');
    return res.redirect('/login');
  }

  const state = generateStateToken();
  const nonce = generateStateToken();

  req.session.entraAuth = {
    state,
    nonce
  };

  return res.redirect(buildAuthorizeUrl(state, nonce));
};

// GET /auth/microsoft/callback
exports.microsoftCallback = async (req, res) => {
  try {
    if (!isEntraConfigured()) {
      req.flash('error', 'Microsoft Entra не е конфигуриран.');
      return res.redirect('/login');
    }

    const {
      code,
      state,
      error,
      error_description: errorDescription
    } = req.query;

    if (error) {
      req.flash('error', `Entra login не успеа: ${errorDescription || error}`);
      return res.redirect('/login');
    }

    const savedAuth = req.session.entraAuth;

    if (
      !savedAuth ||
      !savedAuth.state ||
      !savedAuth.nonce ||
      !state ||
      savedAuth.state !== state
    ) {
      req.flash('error', 'Невалидна Entra сесија. Обидете се повторно.');
      return res.redirect('/login');
    }

    delete req.session.entraAuth;

    if (!code) {
      req.flash('error', 'Не е добиен authorization code од Entra.');
      return res.redirect('/login');
    }

    const tokenResponse = await exchangeCodeForTokens(code);
    const payload = await verifyIdToken(tokenResponse.id_token, savedAuth.nonce);

    const providerId = payload.oid;
    const email = normalizeEmail(getUserEmailFromPayload(payload));

    if (!providerId || !email) {
      req.flash('error', 'Недостигаат OID или email од Entra профилот.');
      return res.redirect('/login');
    }

    if (!isAllowedStudentEmailDomain(email)) {
      req.flash('error', 'Овој емаил домен не е дозволен за Entra најава.');
      return res.redirect('/login');
    }

    let user = await User.findOne({
      where: {
        provider: 'microsoft',
        providerId
      },
      include: userRoleIncludes
    });

    if (!user) {
      user = await User.findOne({
        where: {
          email,
          provider: 'microsoft'
        },
        include: userRoleIncludes
      });

      if (user) {
        await user.update({
          password: null,
          provider: 'microsoft',
          providerId
        });

        user = await User.findOne({
          where: { userId: user.userId },
          include: userRoleIncludes
        });
      }

      if (!user) {
        const studentRole = await Role.findOne({
          where: { tip: 'Student' }
        });

        if (!studentRole) {
          req.flash('error', 'Во системот не постои Student улога.');
          return res.redirect('/login');
        }

        const fullName = payload.name || '';
        const nameParts = fullName.trim().split(' ');

        const ime = nameParts[0] || 'Студент';
        const prezime = nameParts.slice(1).join(' ') || 'Профил';

        user = await User.create({
          ime,
          prezime,
          email,
          password: null,
          roleId: studentRole.roleId,
          provider: 'microsoft',
          providerId,
          authServer: 'smail'
        });

        await Student.create({
          userId: user.userId,
          brIndeks: null,
          smer: null
        });

        user = await User.findOne({
          where: { userId: user.userId },
          include: userRoleIncludes
        });
      }
    }

    if (!user) {
      req.flash('error', 'Корисникот не е пронајден по Entra најава.');
      return res.redirect('/login');
    }

    if (!isStudentUser(user)) {
      req.flash(
        'error',
        'Microsoft Entra најавата е дозволена само за студенти.'
      );
      return res.redirect('/login');
    }

    const roleContext = resolveRoleContext(user);

    if (!roleContext.role) {
      req.flash(
        'error',
        'Корисникот нема валидна улога во системот. Контактирајте администратор.'
      );
      return res.redirect('/login');
    }

    const studentProfile =
      user.studentProfile ||
      await Student.findOne({
        where: { userId: user.userId }
      });

    if (!studentProfile) {
      await Student.create({
        userId: user.userId,
        brIndeks: null,
        smer: null
      });

      user = await User.findOne({
        where: { userId: user.userId },
        include: userRoleIncludes
      });
    }

    req.session.user = buildSessionUser(user);

    return res.redirect('/dashboard');
  } catch (error) {
    console.error('Microsoft callback error:', error);
    req.flash('error', 'Настана грешка при Microsoft Entra најава.');
    return res.redirect('/login');
  }
};

// GET /logout
exports.logout = (req, res) => {
  const role = req.session?.user?.role || null;
  const redirectPath = !role || isStudentRole(role) ? '/login' : '/admin-login';

  req.session.destroy((err) => {
    if (err) console.error('Logout error:', err);

    res.clearCookie('connect.sid');

    return res.redirect(redirectPath);
  });
};