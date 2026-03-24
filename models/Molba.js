const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const Student = require('./Student');

const Molba = sequelize.define('Molba', {
  molbaId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  studentId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: Student,
      key: 'studentId'
    }
  },
  status: {
    type: DataTypes.ENUM('Во процес', 'Одобрена', 'Одбиена'),
    defaultValue: 'Во процес',
    allowNull: false
  },
  datum: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    defaultValue: DataTypes.NOW
  },
  naslov: {
    type: DataTypes.STRING(150),
    allowNull: false,
    defaultValue: 'Без наслов'
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  feedback: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null
  }
}, {
  tableName: 'molbi',
  timestamps: true
});

Student.hasMany(Molba, { foreignKey: 'studentId', as: 'molbi' });
Molba.belongsTo(Student, { foreignKey: 'studentId', as: 'student' });

module.exports = Molba;
