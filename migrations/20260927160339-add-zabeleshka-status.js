'use strict';

// MOLBI_STUDENT_REVISION_V1
// PostgreSQL / Sequelize enum extension for molbi.status.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        ALTER TYPE "enum_molbi_status" ADD VALUE 'Забелешка';
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);
  },

  async down(queryInterface, Sequelize) {
    // PostgreSQL does not support safely removing one enum value in-place.
    // Intentionally left as a no-op; application rollback can stop using it.
  }
};
