'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction =
      await queryInterface.sequelize.transaction();

    try {
      const usersTable =
        await queryInterface.describeTable(
          'users'
        );

      // Ако roleId постои, избриши го
      if (usersTable.roleId) {
        await queryInterface.removeColumn(
          'users',
          'roleId',
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
  },


  async down(queryInterface, Sequelize) {
    const transaction =
      await queryInterface.sequelize.transaction();

    try {
      const usersTable =
        await queryInterface.describeTable(
          'users'
        );

      // Врати го старото поле при rollback
      if (!usersTable.roleId) {
        await queryInterface.addColumn(
          'users',
          'roleId',
          {
            type: Sequelize.INTEGER,
            allowNull: true,

            references: {
              model: 'roles',
              key: 'roleId'
            },

            onUpdate: 'CASCADE',
            onDelete: 'SET NULL'
          },
          {
            transaction
          }
        );
      }

      /*
       * Бидејќи старата структура дозволува
       * само една улога, при rollback земаме
       * една од улогите на корисникот.
       */
      await queryInterface.sequelize.query(
        `
        UPDATE "users" u
        SET "roleId" = x."roleId"
        FROM (
          SELECT
            "userId",
            MIN("roleId") AS "roleId"
          FROM "user_roles"
          GROUP BY "userId"
        ) x
        WHERE u."userId" = x."userId";
        `,
        {
          transaction
        }
      );

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};