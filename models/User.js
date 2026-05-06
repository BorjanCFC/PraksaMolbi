const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const User = sequelize.define('User', {
  userId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  roleId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'roles',
      key: 'roleId'
    },
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE'
  },
  ime: {
    type: DataTypes.STRING,
    allowNull: false
  },
  prezime: {
    type: DataTypes.STRING,
    allowNull: false
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    validate: {
      isEmail: true
    }
  },
  password: {
    type: DataTypes.STRING,
    allowNull: true
  },
  provider: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'local',
    validate: {
      isIn: [['local', 'microsoft', 'feit_pop3']]
    }
  },
  authServer: {
  type: DataTypes.STRING,
  allowNull: false,
  defaultValue: 'smail',
  validate: {
    isIn: [['smail', 'makedon']]
  }
},
  providerId: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true
  }
}, {
  tableName: 'users',
  timestamps: true
});

module.exports = User;
