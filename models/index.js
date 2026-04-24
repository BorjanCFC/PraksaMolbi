const User = require('./User');
const Molba = require('./Molba');
const Student = require('./Student');
const Role = require('./Role');

User.belongsTo(Role, { foreignKey: 'roleId', as: 'role' });
Role.hasMany(User, { foreignKey: 'roleId', as: 'users' });

User.hasOne(Student, { foreignKey: 'userId', as: 'studentProfile' });
Student.belongsTo(User, { foreignKey: 'userId', as: 'user' });

User.hasMany(Molba, { foreignKey: 'userId', as: 'molbi' });
Molba.belongsTo(User, { foreignKey: 'userId', as: 'student' });

module.exports = {
	User,
	Molba,
	Student,
	Role
};
