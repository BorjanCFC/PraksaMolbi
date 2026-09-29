const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Student = sequelize.define('Student', {
  userId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    references: {
      model: 'users',
      key: 'userId'
    },
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  },
  brIndeks: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true
  },
  smer: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // MOLBI_STUDENT_REQUEST_NUMBERING_PDF_NAMES_V1
  brojMolbi: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'broj_molbi'
  }
}, {
  tableName: 'students',
  timestamps: false
});

module.exports = Student;