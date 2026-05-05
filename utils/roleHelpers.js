const ROLE = Object.freeze({
  STUDENT: 'student',
  ADMIN: 'admin',
  STUDENTSKA_SLUZHBA: 'studentska_sluzhba',
  PRODEKAN: 'prodekan',
  ARHIVA: 'arhiva'
});

const ROLE_TIP = Object.freeze({
  ADMIN: 'Admin',
  STUDENTSKA_SLUZHBA: 'Sluzhba',
  PRODEKAN: 'Prodekan',
  ARHIVA: 'Arhiva'
});

const roleLabelMap = {
  [ROLE.STUDENT]: 'Студент',
  [ROLE.ADMIN]: 'Админ',
  [ROLE.STUDENTSKA_SLUZHBA]: 'Студентска Служба',
  [ROLE.PRODEKAN]: 'Продекан',
  [ROLE.ARHIVA]: 'Архива'
};

const roleFromTipMap = {
  [ROLE_TIP.ADMIN]: ROLE.ADMIN,
  [ROLE_TIP.STUDENTSKA_SLUZHBA]: ROLE.STUDENTSKA_SLUZHBA,
  [ROLE_TIP.PRODEKAN]: ROLE.PRODEKAN,
  [ROLE_TIP.ARHIVA]: ROLE.ARHIVA
};

const managementRoles = new Set([ROLE.ADMIN, ROLE.STUDENTSKA_SLUZHBA, ROLE.PRODEKAN]);
const staffRoles = new Set([ROLE.ADMIN, ROLE.STUDENTSKA_SLUZHBA, ROLE.PRODEKAN, ROLE.ARHIVA]);

const normalizeRoleTip = (tip) => {
  if (!tip) return null;
  const normalized = String(tip).trim().toLowerCase();

  if (normalized === 'admin') return ROLE_TIP.ADMIN;
  if (normalized === 'sluzhba' || normalized === 'studentska_sluzhba' || normalized === 'studentska sluzhba') {
    return ROLE_TIP.STUDENTSKA_SLUZHBA;
  }
  if (normalized === 'prodekan') return ROLE_TIP.PRODEKAN;
  if (normalized === 'arhiva') return ROLE_TIP.ARHIVA;

  return null;
};

const roleFromTip = (tip) => {
  const normalizedTip = normalizeRoleTip(tip);
  if (!normalizedTip) return null;
  return roleFromTipMap[normalizedTip] || null;
};

const getRoleLabel = (role) => roleLabelMap[role] || role;

const resolveRoleContext = (userInstance) => {
  if (!userInstance) {
    return {
      roleId: null,
      role: null,
      roleLabel: null,
      roleTip: null,
      brIndeks: null
    };
  }

  if (userInstance.studentProfile) {
    return {
      roleId: null,
      role: ROLE.STUDENT,
      roleLabel: getRoleLabel(ROLE.STUDENT),
      roleTip: null,
      brIndeks: userInstance.studentProfile.brIndeks
    };
  }

  const roleTip = userInstance.role ? normalizeRoleTip(userInstance.role.tip) : null;
  const role = roleFromTip(roleTip);

  return {
    roleId: userInstance.roleId || null,
    role,
    roleLabel: getRoleLabel(role),
    roleTip,
    brIndeks: null
  };
};

const isStudentRole = (role) => role === ROLE.STUDENT;
const isStaffRole = (role) => staffRoles.has(role);
const canManageMolbi = (role) => managementRoles.has(role);

module.exports = {
  ROLE,
  ROLE_TIP,
  getRoleLabel,
  roleFromTip,
  resolveRoleContext,
  isStudentRole,
  isStaffRole,
  canManageMolbi
};
