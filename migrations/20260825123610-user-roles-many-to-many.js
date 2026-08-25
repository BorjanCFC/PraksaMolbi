'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction =
      await queryInterface.sequelize.transaction();

    try {
      /*
       * 1. Креирај user_roles ако не постои.
       *
       * Локално веќе ја имаме,
       * но на production серверот можеби ја нема.
       */
      await queryInterface.sequelize.query(
        `
        CREATE TABLE IF NOT EXISTS "user_roles" (
          "userId" INTEGER NOT NULL,
          "roleId" INTEGER NOT NULL,

          CONSTRAINT "pk_user_roles"
            PRIMARY KEY ("userId", "roleId"),

          CONSTRAINT "fk_user_roles_user"
            FOREIGN KEY ("userId")
            REFERENCES "users" ("userId")
            ON UPDATE CASCADE
            ON DELETE CASCADE,

          CONSTRAINT "fk_user_roles_role"
            FOREIGN KEY ("roleId")
            REFERENCES "roles" ("roleId")
            ON UPDATE CASCADE
            ON DELETE CASCADE
        );
        `,
        { transaction }
      );

      /*
       * 2. Проверуваме дали users.roleId сè уште постои.
       */
      const usersTable =
        await queryInterface.describeTable(
          'users'
        );

      if (usersTable.roleId) {
        /*
         * 3. Префрли ги старите улоги
         * од users.roleId во user_roles.
         */
        await queryInterface.sequelize.query(
          `
          INSERT INTO "user_roles" ("userId", "roleId")
          SELECT
            "userId",
            "roleId"
          FROM "users"
          WHERE "roleId" IS NOT NULL
          ON CONFLICT ("userId", "roleId")
          DO NOTHING;
          `,
          { transaction }
        );

        /*
         * 4. Откако се копирани,
         * users.roleId повеќе не ни треба.
         */
        await queryInterface.removeColumn(
          'users',
          'roleId',
          { transaction }
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
      /*
       * Rollback кон старата структура.
       *
       * ВАЖНО:
       * старата структура поддржува само една role,
       * затоа при rollback се зема една од улогите.
       */

      const usersTable =
        await queryInterface.describeTable(
          'users'
        );

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
          { transaction }
        );
      }

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
        { transaction }
      );

      await queryInterface.dropTable(
        'user_roles',
        { transaction }
      );

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};