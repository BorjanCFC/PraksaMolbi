const ROLE = Object.freeze({
  STUDENT: 'student',
  ADMIN: 'admin',
  STUDENTSKA_SLUZHBA: 'studentska_sluzhba',
  PRODEKAN: 'prodekan',
  ARHIVA: 'arhiva'
});

const ROLE_TIP = Object.freeze({
  STUDENT: 'Student',
  ADMIN: 'Admin',
  STUDENTSKA_SLUZHBA: 'Sluzhba',
  PRODEKAN: 'Prodekan',
  ARHIVA: 'Arhiva'
});

const roleLabelMap = {
  [ROLE.STUDENT]: 'Студент',
  [ROLE.ADMIN]: 'Админ',
  [ROLE.STUDENTSKA_SLUZHBA]: 'Студентска служба',
  [ROLE.PRODEKAN]: 'Продекан',
  [ROLE.ARHIVA]: 'Архива'
};

const roleFromTipMap = {
  [ROLE_TIP.STUDENT]: ROLE.STUDENT,
  [ROLE_TIP.ADMIN]: ROLE.ADMIN,
  [ROLE_TIP.STUDENTSKA_SLUZHBA]: ROLE.STUDENTSKA_SLUZHBA,
  [ROLE_TIP.PRODEKAN]: ROLE.PRODEKAN,
  [ROLE_TIP.ARHIVA]: ROLE.ARHIVA
};

const managementRoles = new Set([
  ROLE.ADMIN,
  ROLE.STUDENTSKA_SLUZHBA,
  ROLE.PRODEKAN
]);

const staffRoles = new Set([
  ROLE.ADMIN,
  ROLE.STUDENTSKA_SLUZHBA,
  ROLE.PRODEKAN,
  ROLE.ARHIVA
]);

const normalizeRoleTip = (tip) => {
  if (!tip) return null;

  const normalized = String(tip).trim().toLowerCase();

  if (
    normalized === 'student' ||
    normalized === 'студент'
  ) {
    return ROLE_TIP.STUDENT;
  }

  if (
    normalized === 'admin' ||
    normalized === 'админ'
  ) {
    return ROLE_TIP.ADMIN;
  }

  if (
    normalized === 'sluzhba' ||
    normalized === 'studentska_sluzhba' ||
    normalized === 'studentska sluzhba' ||
    normalized === 'служба' ||
    normalized === 'студентска служба'
  ) {
    return ROLE_TIP.STUDENTSKA_SLUZHBA;
  }

  if (
    normalized === 'prodekan' ||
    normalized === 'продекан'
  ) {
    return ROLE_TIP.PRODEKAN;
  }

  if (
    normalized === 'arhiva' ||
    normalized === 'архива'
  ) {
    return ROLE_TIP.ARHIVA;
  }

  return null;
};

const roleFromTip = (tip) => {
  const normalizedTip = normalizeRoleTip(tip);

  if (!normalizedTip) return null;

  return roleFromTipMap[normalizedTip] || null;
};

const getRoleLabel = (role) => {
  if (!role) return null;

  return roleLabelMap[role] || role;
};

/**
 * Креира стандарден role context од Sequelize Role instance.
 */
const buildRoleContext = (roleInstance, brIndeks = null) => {
  if (!roleInstance) return null;

  const roleTip = normalizeRoleTip(roleInstance.tip);
  const role = roleFromTip(roleTip);

  if (!role) return null;

  return {
    roleId: roleInstance.roleId || null,
    role,
    roleLabel: getRoleLabel(role),
    roleTip,
    brIndeks: role === ROLE.STUDENT ? brIndeks : null
  };
};

/**
 * Ги враќа СИТЕ улоги на корисникот.
 *
 * Нов систем:
 * user.roles = [Role, Role, ...]
 *
 * Стар систем:
 * user.role = Role
 *
 * Засега ги поддржуваме и двата начина.
 */
const resolveRoleContexts = (userInstance) => {
  if (!userInstance) return [];

  const contexts = [];
  const seenRoleIds = new Set();
  const seenRoles = new Set();

  const brIndeks =
    userInstance.studentProfile?.brIndeks || null;

  const addContext = (context) => {
    if (!context || !context.role) return;

    if (
      context.roleId &&
      seenRoleIds.has(context.roleId)
    ) {
      return;
    }

    if (
      !context.roleId &&
      seenRoles.has(context.role)
    ) {
      return;
    }

    if (context.roleId) {
      seenRoleIds.add(context.roleId);
    }

    seenRoles.add(context.role);

    contexts.push(context);
  };

  // Нова M:N релација
  if (Array.isArray(userInstance.roles)) {
    for (const roleInstance of userInstance.roles) {
      addContext(
        buildRoleContext(roleInstance, brIndeks)
      );
    }
  }

  // Стара M:1 релација - ја задржуваме привремено
  if (userInstance.role) {
    addContext(
      buildRoleContext(
        userInstance.role,
        brIndeks
      )
    );
  }

  // Дополнителна заштита за студентите
  if (
    userInstance.studentProfile &&
    !contexts.some(
      (context) => context.role === ROLE.STUDENT
    )
  ) {
    addContext({
      roleId: null,
      role: ROLE.STUDENT,
      roleLabel: getRoleLabel(ROLE.STUDENT),
      roleTip: ROLE_TIP.STUDENT,
      brIndeks
    });
  }

  return contexts;
};

/**
 * Враќа една активна улога.
 *
 * Засега:
 * - ако е зададена preferredRole -> ја користи неа
 * - потоа ја преферира старата users.roleId
 * - Microsoft студент -> Student
 * - инаку ја зема првата достапна улога
 *
 * Подоцна preferredRole ќе доаѓа од select-role страницата.
 */
const resolveRoleContext = (
  userInstance,
  preferredRole = null
) => {
  const emptyContext = {
    roleId: null,
    role: null,
    roleLabel: null,
    roleTip: null,
    brIndeks: null
  };

  if (!userInstance) {
    return emptyContext;
  }

  const contexts = resolveRoleContexts(userInstance);

  if (!contexts.length) {
    return emptyContext;
  }

  // Ако експлицитно сме побарале конкретна улога
  if (preferredRole) {
    const normalizedPreferredRole =
      roleFromTip(preferredRole) ||
      String(preferredRole).trim().toLowerCase();

    const preferredContext = contexts.find(
      (context) =>
        context.role === normalizedPreferredRole
    );

    if (preferredContext) {
      return preferredContext;
    }
  }

  // Додека постои users.roleId,
  // ја користиме како default активна улога.
  if (userInstance.roleId) {
    const legacyContext = contexts.find(
      (context) =>
        context.roleId === userInstance.roleId
    );

    if (legacyContext) {
      return legacyContext;
    }
  }

  // Microsoft login е студентски login.
  if (userInstance.provider === 'microsoft') {
    const studentContext = contexts.find(
      (context) =>
        context.role === ROLE.STUDENT
    );

    if (studentContext) {
      return studentContext;
    }
  }

  return contexts[0];
};

const hasRole = (userInstance, role) => {
  if (!userInstance || !role) return false;

  const normalizedRole =
    roleFromTip(role) ||
    String(role).trim().toLowerCase();

  return resolveRoleContexts(userInstance)
    .some(
      (context) =>
        context.role === normalizedRole
    );
};

const isStudentRole = (role) => {
  return role === ROLE.STUDENT;
};

const isStaffRole = (role) => {
  return staffRoles.has(role);
};

const canManageMolbi = (role) => {
  return managementRoles.has(role);
};

module.exports = {
  ROLE,
  ROLE_TIP,
  getRoleLabel,
  roleFromTip,
  normalizeRoleTip,
  resolveRoleContext,
  resolveRoleContexts,
  hasRole,
  isStudentRole,
  isStaffRole,
  canManageMolbi
};