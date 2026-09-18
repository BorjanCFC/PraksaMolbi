'use strict';
// MOLBI_DECISION_PROOF_ONE_PAGE_V1
// Historical requests stay NULL: timestamps/approvers must never be fabricated.
module.exports = {
  async up(queryInterface, Sequelize) {
    const existing = await queryInterface.describeTable('molbi');
    if (existing.decision_at || existing.decision_by_user_id) {
      throw new Error('Decision columns already exist. Inspect migration history.');
    }
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn('molbi', 'decision_at', {
        type: Sequelize.DATE, allowNull: true, defaultValue: null
      }, { transaction });
      await queryInterface.addColumn('molbi', 'decision_by_user_id', {
        type: Sequelize.INTEGER, allowNull: true, defaultValue: null,
        references: { model: 'users', key: 'userId' },
        onDelete: 'RESTRICT', onUpdate: 'CASCADE'
      }, { transaction });
      await queryInterface.sequelize.query(
        `ALTER TABLE "molbi" ADD CONSTRAINT "molbi_decision_evidence_pair_chk"
         CHECK (("decision_at" IS NULL) = ("decision_by_user_id" IS NULL))`,
        { transaction }
      );
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeConstraint('molbi', 'molbi_decision_evidence_pair_chk', { transaction });
      await queryInterface.removeColumn('molbi', 'decision_by_user_id', { transaction });
      await queryInterface.removeColumn('molbi', 'decision_at', { transaction });
    });
  }
};
