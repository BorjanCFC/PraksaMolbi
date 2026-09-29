const User = require('./User');
const Molba = require('./Molba');
const Student = require('./Student');
const Role = require('./Role');
const UserRole = require('./UserRole');
// MOLBI_ACADEMIC_PERIOD_ARCHIVE_V1
const AcademicPeriod = require('./AcademicPeriod');

// User <-> Role M:N
User.belongsToMany(Role, {
  through: UserRole,
  foreignKey: 'userId',
  otherKey: 'roleId',
  as: 'roles'
});

Role.belongsToMany(User, {
  through: UserRole,
  foreignKey: 'roleId',
  otherKey: 'userId',
  as: 'users'
});

// User <-> Student
User.hasOne(Student, {
  foreignKey: 'userId',
  as: 'studentProfile'
});

Student.belongsTo(User, {
  foreignKey: 'userId',
  as: 'user'
});

// User <-> Molba
User.hasMany(Molba, {
  foreignKey: 'userId',
  as: 'molbi'
});

Molba.belongsTo(User, {
  foreignKey: 'userId',
  as: 'student'
});


// AcademicPeriod <-> Molba
AcademicPeriod.hasMany(Molba, {
  foreignKey: 'academicPeriodId',
  as: 'molbi'
});

Molba.belongsTo(AcademicPeriod, {
  foreignKey: 'academicPeriodId',
  as: 'academicPeriod'
});

module.exports = {
  User,
  Molba,
  Student,
  Role,
  UserRole,
  AcademicPeriod
};