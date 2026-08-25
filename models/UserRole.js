const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const UserRole = sequelize.define('UserRole', {
  userId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    allowNull: false,
    references: {
      model: 'users',
      key: 'userId'
    },
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  },

  roleId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    allowNull: false,
    references: {
      model: 'roles',
      key: 'roleId'
    },
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  }
}, {
  tableName: 'user_roles',
  timestamps: false
});

module.exports = UserRole;