'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction =
      await queryInterface.sequelize.transaction();

    try {
      const table =
        await queryInterface.describeTable(
          'molbi'
        );

      if (!table.workflow_stage) {
        await queryInterface.addColumn(
          'molbi',
          'workflow_stage',
          {
            type: Sequelize.STRING(30),
            allowNull: false,
            defaultValue: 'SUBMITTED'
          },
          {
            transaction
          }
        );
      }

      if (!table.sluzhba_feedback) {
        await queryInterface.addColumn(
          'molbi',
          'sluzhba_feedback',
          {
            type: Sequelize.TEXT,
            allowNull: true,
            defaultValue: null
          },
          {
            transaction
          }
        );
      }

      if (!table.prodekan_feedback) {
        await queryInterface.addColumn(
          'molbi',
          'prodekan_feedback',
          {
            type: Sequelize.TEXT,
            allowNull: true,
            defaultValue: null
          },
          {
            transaction
          }
        );
      }

      /*
       * Постоечките молби ги поставуваме
       * во соодветна workflow фаза.
       */
      await queryInterface.sequelize.query(
        `
        UPDATE "molbi"
        SET "workflow_stage" =
          CASE
            WHEN "arhiva_pdf_path" IS NOT NULL
              THEN 'COMPLETED'

            WHEN "status" IN ('Одобрена', 'Одбиена')
              THEN 'DECIDED'

            WHEN "arhivski_broj" IS NOT NULL
              THEN 'ARCHIVED'

            ELSE 'SUBMITTED'
          END
        `,
        {
          transaction
        }
      );

      /*
       * Нема showIndex во средина на transaction.
       * Migration-та се извршува само еднаш,
       * па директно го креираме index-от.
       */
      await queryInterface.addIndex(
        'molbi',
        ['workflow_stage'],
        {
          name: 'molbi_workflow_stage_idx',
          transaction
        }
      );

      await transaction.commit();

    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },


  async down(queryInterface) {
    const transaction =
      await queryInterface.sequelize.transaction();

    try {
      /*
       * Го тргаме index-от директно.
       */
      await queryInterface.removeIndex(
        'molbi',
        'molbi_workflow_stage_idx',
        {
          transaction
        }
      );

      const table =
        await queryInterface.describeTable(
          'molbi'
        );

      if (table.prodekan_feedback) {
        await queryInterface.removeColumn(
          'molbi',
          'prodekan_feedback',
          {
            transaction
          }
        );
      }

      if (table.sluzhba_feedback) {
        await queryInterface.removeColumn(
          'molbi',
          'sluzhba_feedback',
          {
            transaction
          }
        );
      }

      if (table.workflow_stage) {
        await queryInterface.removeColumn(
          'molbi',
          'workflow_stage',
          {
            transaction
          }
        );
      }

      await transaction.commit();

    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};