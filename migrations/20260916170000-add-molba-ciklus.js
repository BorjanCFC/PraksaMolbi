'use strict';

// Existing historical requests remain NULL until their cycle is identified.
module.exports = {
  async up(queryInterface, Sequelize) {
    const existing = await queryInterface.describeTable('molbi');
    if (existing.ciklus) {
      throw new Error('molbi.ciklus already exists; review schema and migration history.');
    }
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn('molbi', 'ciklus', {
        type: Sequelize.STRING(10),
        allowNull: true,
        defaultValue: null
      }, { transaction });
      await queryInterface.sequelize.query(
        `ALTER TABLE "molbi" ADD CONSTRAINT "molbi_ciklus_valid_chk"
         CHECK ("ciklus" IN ('Прв', 'Втор'))`,
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeConstraint('molbi', 'molbi_ciklus_valid_chk', { transaction });
      await queryInterface.removeColumn('molbi', 'ciklus', { transaction });
    });
  }
};
