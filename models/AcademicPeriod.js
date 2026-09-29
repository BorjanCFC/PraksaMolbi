const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// MOLBI_ACADEMIC_PERIOD_ARCHIVE_V1
const AcademicPeriod = sequelize.define('AcademicPeriod', {
  academicPeriodId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
    field: 'academic_period_id'
  },

  semestar: {
    type: DataTypes.STRING(10),
    allowNull: false,
    validate: {
      isIn: [['Зимски', 'Летен']]
    }
  },

  ucebnaGodina: {
    type: DataTypes.STRING(9),
    allowNull: false,
    field: 'ucebna_godina',
    validate: {
      is: /^\d{4}\/\d{4}$/
    }
  },

  status: {
    type: DataTypes.STRING(10),
    allowNull: false,
    defaultValue: 'OPEN',
    validate: {
      isIn: [['OPEN', 'CLOSED']]
    }
  },

  openedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
    field: 'opened_at'
  },

  closedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
    field: 'closed_at'
  },

  openedByUserId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    field: 'opened_by_user_id',
    references: {
      model: 'users',
      key: 'userId'
    }
  },

  closedByUserId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    field: 'closed_by_user_id',
    references: {
      model: 'users',
      key: 'userId'
    }
  }
}, {
  tableName: 'academic_periods',
  timestamps: true,
  indexes: [
    {
      unique: true,
      fields: ['semestar', 'ucebna_godina'],
      name: 'academic_periods_semester_year_unique'
    }
  ]
});

module.exports = AcademicPeriod;
