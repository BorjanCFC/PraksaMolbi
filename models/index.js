const User = require('./User');
const Molba = require('./Molba');
const Student = require('./Student');
const Role = require('./Role');
const UserRole = require('./UserRole');

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

module.exports = {
  User,
  Molba,
  Student,
  Role,
  UserRole
};