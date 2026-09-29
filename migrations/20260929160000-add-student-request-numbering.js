"use strict";

// MOLBI_STUDENT_REQUEST_NUMBERING_PDF_NAMES_V1
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(
      'students',
      'broj_molbi',
      {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      }
    );

    await queryInterface.addColumn(
      'molbi',
      'student_molba_broj',
      {
        type: Sequelize.INTEGER,
        allowNull: true
      }
    );

    /*
     * Existing data:
     * molbaId already represents creation order globally, so ROW_NUMBER over
     * each user gives a deterministic historical per-student sequence.
     */
    await queryInterface.sequelize.query(`
      WITH ranked AS (
        SELECT
          "molbaId",
          ROW_NUMBER() OVER (
            PARTITION BY "userId"
            ORDER BY "molbaId" ASC
          )::integer AS student_number
        FROM "molbi"
      )
      UPDATE "molbi" AS m
      SET "student_molba_broj" = ranked.student_number
      FROM ranked
      WHERE m."molbaId" = ranked."molbaId";
    `);

    /* Keep Student.brojMolbi equal to the highest allocated ordinal. */
    await queryInterface.sequelize.query(`
      UPDATE "students" AS s
      SET "broj_molbi" = COALESCE((
        SELECT MAX(m."student_molba_broj")
        FROM "molbi" AS m
        WHERE m."userId" = s."userId"
      ), 0);
    `);

    await queryInterface.changeColumn(
      'molbi',
      'student_molba_broj',
      {
        type: Sequelize.INTEGER,
        allowNull: false
      }
    );

    await queryInterface.addConstraint(
      'molbi',
      {
        fields: ['userId', 'student_molba_broj'],
        type: 'unique',
        name: 'molbi_user_student_molba_broj_unique'
      }
    );
  },

  async down(queryInterface) {
    try {
      await queryInterface.removeConstraint(
        'molbi',
        'molbi_user_student_molba_broj_unique'
      );
    } catch (_) {
      // Safe rollback if the constraint is already missing.
    }

    await queryInterface.removeColumn('molbi', 'student_molba_broj');
    await queryInterface.removeColumn('students', 'broj_molbi');
  }
};
