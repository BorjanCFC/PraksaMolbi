const bcrypt = require('bcryptjs');
const {
  User,
  Student,
  Role
} = require('../models');
const { resolveRoleContext, isStudentRole } = require('../utils/roleHelpers');
const {
  isEntraConfigured,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  verifyIdToken,
  generateStateToken,
  getEntraConfig
} = require('../config/entraAuth');

const isLoggedIn = (req) => req.session && !!req.session.user;

const userRoleIncludes = [
  { model: Student, as: 'studentProfile', required: false },
  { model: Role, as: 'role', required: false }
];

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
    authProvider: user.provider || 'local'
  };
};

const getUserEmailFromPayload = (payload) => {
  return payload.preferred_username || payload.email || payload.upn || null;
};

const isStudentUser = (user) => {
  const roleContext = resolveRoleContext(user);
  return roleContext.role === 'student';
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
  try {
    const { email, password } = req.body;

    const user = await User.findOne({
      where: { email },
      include: userRoleIncludes
    });

    if (user) {
      const roleContext = resolveRoleContext(user);
      if (!roleContext.role) {
        req.flash('error', 'Корисникот нема валиден профил во системот.');
        return res.redirect('/login');
      }

      if (roleContext.role === 'student' || user.provider === 'microsoft') {
        req.flash('error', 'Студентите се најавуваат преку Microsoft Entra копчето.');
        return res.redirect('/login');
      }

      if (!user.password) {
        req.flash('error', 'Овој корисник нема локална лозинка.');
        return res.redirect('/login');
      }

      const isMatch = await bcrypt.compare(password, user.password);
      if (isMatch) {
        req.session.user = buildSessionUser(user);

        return res.redirect('/dashboard');
      }
    }

    req.flash('error', 'Невалиден email или лозинка.');
    return res.redirect('/login');
  } catch (error) {
    console.error('Login error:', error);
    req.flash('error', 'Настана грешка при најава.');
    return res.redirect('/login');
  }
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

    const { code, state, error, error_description: errorDescription } = req.query;
    if (error) {
      req.flash('error', `Entra login не успеа: ${errorDescription || error}`);
      return res.redirect('/login');
    }

    const savedAuth = req.session.entraAuth;
    if (!savedAuth || !savedAuth.state || !savedAuth.nonce || !state || savedAuth.state !== state) {
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
    const email = getUserEmailFromPayload(payload);
    if (!providerId || !email) {
      req.flash('error', 'Недостигаат OID или email од Entra профилот.');
      return res.redirect('/login');
    }

    if (!isAllowedStudentEmailDomain(email)) {
      req.flash('error', 'Овој емаил домен не е дозволен за Entra најава.');
      return res.redirect('/login');
    }

    let user = await User.findOne({
      where: { provider: 'microsoft', providerId },
      include: userRoleIncludes
    });

    if (!user) {
      user = await User.findOne({
        where: { email: email.toLowerCase() },
        include: userRoleIncludes
      });

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

        const ime = nameParts[0] || '';
        const prezime = nameParts.slice(1).join(' ') || '';

        user = await User.create({
          ime,
          prezime,
          email: email.toLowerCase(),
          password: null,
          roleId: studentRole.roleId,
          provider: 'microsoft',
          providerId
        });

        await Student.create({
          userId: user.userId,
          brIndeks: null,
          smer: null
        });

        user = await User.findOne({
          where: { email: email.toLowerCase() },
          include: userRoleIncludes
        });
      }
    }

    if (!user) {
      req.flash('error', 'Корисникот не е пронајден по Entra најава.');
      return res.redirect('/login');
    }

    const roleContext = resolveRoleContext(user);
    if (!roleContext.role) {
      req.flash('error', 'Корисникот нема валидна улога во системот. Контактирајте администратор.');
      return res.redirect('/login');
    }

    if (roleContext.role === 'student') {
      const studentProfile = user.studentProfile || await Student.findOne({ where: { userId: user.userId } });
      if (!studentProfile) {
        await Student.create({ userId: user.userId, brIndeks: null, smer: null });
        user = await User.findOne({
          where: { userId: user.userId },
          include: userRoleIncludes
        });
      }
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
