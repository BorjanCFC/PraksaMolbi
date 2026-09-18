const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Molba = sequelize.define('Molba', {
  molbaId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'users',
      key: 'userId'
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
  semestar: {
    type: DataTypes.ENUM('Зимски', 'Летен'),
    allowNull: false,
    defaultValue: 'Зимски'
  },
  ucebnaGodina: {
    type: DataTypes.STRING(9),
    allowNull: false,
    defaultValue: '2025/2026',
    field: 'ucebna_godina',
    validate: {
      is: /^\d{4}\/\d{4}$/
    }
  },
  ciklus: {
    type: DataTypes.STRING(10),
    allowNull: true, // Legacy molbi can have an unknown study cycle.
    defaultValue: null,
    validate: { isIn: [['Прв', 'Втор']] }
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  arhivskiBroj: {
    type: DataTypes.STRING(100),
    allowNull: true,
    unique: true,
    field: 'arhivski_broj',
    validate: {
      notEmpty: true
    }
  },
  urlPath: {
    type: DataTypes.STRING(255),
    allowNull: true,
    field: 'url_path',
    validate: {
      notEmpty: true
    }
  },
  arhivaPdfPath: {
    type: DataTypes.STRING(255),
    allowNull: true,
    field: 'arhiva_pdf_path',
    validate: {
      notEmpty: true
    }
  },

  workflowStage: {
    type: DataTypes.STRING(30),
    allowNull: false,
    defaultValue: 'SUBMITTED',
    field: 'workflow_stage',
    validate: {
      isIn: [[
        'SUBMITTED',
        'ARCHIVED',
        'SERVICE_REVIEWED',
        'DECIDED',
        'COMPLETED'
      ]]
    }
  },

  sluzhbaFeedback: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
    field: 'sluzhba_feedback'
  },

  // MOLBI_DECISION_PROOF_ONE_PAGE_V1
  // Authoritative decision evidence: written when the vice-dean saves the decision.
  decisionAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
    field: 'decision_at'
  },
  decisionByUserId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    field: 'decision_by_user_id',
    references: { model: 'users', key: 'userId' }
  },

  prodekanFeedback: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
    field: 'prodekan_feedback'
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

module.exports = Molba;
