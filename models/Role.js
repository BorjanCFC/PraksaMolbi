const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Role = sequelize.define('Role', {
  roleId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  tip: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    validate: {
      isIn: [['Student', 'Admin', 'Sluzhba', 'Prodekan', 'Arhiva']]
    }
  }
}, {
  tableName: 'roles',
  timestamps: false
});

module.exports = Role;