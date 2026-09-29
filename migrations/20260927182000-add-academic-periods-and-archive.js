'use strict';

// MOLBI_ACADEMIC_PERIOD_ARCHIVE_V1
// Adds academic-period management and assigns existing requests to periods.
// The latest existing semester/year is treated as OPEN; older combinations
// are imported as CLOSED archive periods.
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.createTable('academic_periods', {
        academic_period_id: {
          type: Sequelize.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false
        },
        semestar: {
          type: Sequelize.STRING(10),
          allowNull: false
        },
        ucebna_godina: {
          type: Sequelize.STRING(9),
          allowNull: false
        },
        status: {
          type: Sequelize.STRING(10),
          allowNull: false,
          defaultValue: 'OPEN'
        },
        opened_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.fn('NOW')
        },
        closed_at: {
          type: Sequelize.DATE,
          allowNull: true
        },
        opened_by_user_id: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'users', key: 'userId' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL'
        },
        closed_by_user_id: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'users', key: 'userId' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL'
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.fn('NOW')
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.fn('NOW')
        }
      }, { transaction });

      await queryInterface.addConstraint('academic_periods', {
        fields: ['semestar', 'ucebna_godina'],
        type: 'unique',
        name: 'academic_periods_semester_year_unique',
        transaction
      });

      await queryInterface.addColumn('molbi', 'academic_period_id', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'academic_periods',
          key: 'academic_period_id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      }, { transaction });

      await queryInterface.addIndex('molbi', ['academic_period_id'], {
        name: 'molbi_academic_period_idx',
        transaction
      });

      // PostgreSQL partial unique index: at most one OPEN period globally.
      await queryInterface.sequelize.query(`
        CREATE UNIQUE INDEX academic_periods_one_open_idx
        ON academic_periods (status)
        WHERE status = 'OPEN';
      `, { transaction });

      const [pairs] = await queryInterface.sequelize.query(`
        SELECT DISTINCT semestar, ucebna_godina
        FROM molbi
        WHERE semestar IN ('Зимски', 'Летен')
          AND ucebna_godina ~ '^[0-9]{4}/[0-9]{4}$';
      `, { transaction });

      const ordered = [...pairs].sort((a, b) => {
        const ay = Number(String(a.ucebna_godina || '').split('/')[0]) || 0;
        const by = Number(String(b.ucebna_godina || '').split('/')[0]) || 0;
        if (ay !== by) return ay - by;
        const rank = { 'Зимски': 0, 'Летен': 1 };
        return (rank[a.semestar] ?? -1) - (rank[b.semestar] ?? -1);
      });

      for (let index = 0; index < ordered.length; index += 1) {
        const pair = ordered[index];
        const isLatest = index === ordered.length - 1;
        const status = isLatest ? 'OPEN' : 'CLOSED';

        const [inserted] = await queryInterface.sequelize.query(`
          INSERT INTO academic_periods
            (semestar, ucebna_godina, status, opened_at, closed_at, "createdAt", "updatedAt")
          VALUES
            (:semestar, :year, :status, NOW(), CASE WHEN :status = 'CLOSED' THEN NOW() ELSE NULL END, NOW(), NOW())
          RETURNING academic_period_id;
        `, {
          replacements: {
            semestar: pair.semestar,
            year: pair.ucebna_godina,
            status
          },
          transaction
        });

        const periodId = inserted[0].academic_period_id;

        await queryInterface.sequelize.query(`
          UPDATE molbi
          SET academic_period_id = :periodId
          WHERE semestar = :semestar
            AND ucebna_godina = :year
            AND academic_period_id IS NULL;
        `, {
          replacements: {
            periodId,
            semestar: pair.semestar,
            year: pair.ucebna_godina
          },
          transaction
        });
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.removeColumn('molbi', 'academic_period_id', { transaction });
      await queryInterface.dropTable('academic_periods', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
