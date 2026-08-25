require('dotenv').config();

const bcrypt = require('bcryptjs');

const sequelize = require('../config/database');

const {
  User,
  Role,
  UserRole
} = require('../models');


const initAdminAccount = async () => {
  try {
    /*
     * Не користиме alter:true.
     * Структурата на база ја менуваме преку migrations/reset.
     */
    await sequelize.sync();

    console.log('Bazata e sinhronizirana.');


    /* =====================================================
       ROLES
    ===================================================== */

    const roles = [
      'Student',
      'Admin',
      'Sluzhba',
      'Prodekan',
      'Arhiva'
    ];


    for (const tip of roles) {
      const [role, created] =
        await Role.findOrCreate({
          where: {
            tip
          },
          defaults: {
            tip
          }
        });


      if (created) {
        console.log(
          `Kreirana uloga: ${role.tip}`
        );
      }
    }


    /* =====================================================
       ADMIN CONFIG
    ===================================================== */

    const adminEmail =
      (
        process.env.ADMIN_EMAIL ||
        'admin@university.mk'
      )
        .toLowerCase()
        .trim();


    /*
     * Ако ADMIN_PASSWORD постои во .env,
     * ќе се користи таа вредност.
     *
     * Инаку default е password123.
     */
    const adminPassword =
      process.env.ADMIN_PASSWORD ||
      'password123';


    const adminIme =
      process.env.ADMIN_IME ||
      'Админ';


    const adminPrezime =
      process.env.ADMIN_PREZIME ||
      'Глобален';


    /* =====================================================
       FIND ADMIN ROLE
    ===================================================== */

    const adminRole =
      await Role.findOne({
        where: {
          tip: 'Admin'
        }
      });


    if (!adminRole) {
      console.error(
        'Ne postoi Admin uloga vo bazata.'
      );

      process.exit(1);
    }


    /* =====================================================
       PASSWORD HASH
    ===================================================== */

    const hashedPassword =
      await bcrypt.hash(
        adminPassword,
        10
      );


    /* =====================================================
       CREATE / FIND USER
    ===================================================== */

    let adminUser =
      await User.findOne({
        where: {
          email: adminEmail
        }
      });


    if (!adminUser) {

      adminUser =
        await User.create({
          ime: adminIme,
          prezime: adminPrezime,

          email:
            adminEmail,

          password:
            hashedPassword,

          provider:
            'local',

          providerId:
            null,

          authServer:
            'smail'
        });


      console.log(
        `Kreiran lokalen bootstrap admin: ${adminEmail}`
      );

    } else {

      /*
       * Ако account-от веќе постои,
       * го освежуваме bootstrap admin-от.
       *
       * Ова е корисно локално ако повторно
       * пуштиш npm run init-admin.
       */
      await adminUser.update({
        ime: adminIme,
        prezime: adminPrezime,

        password:
          hashedPassword,

        provider:
          'local',

        authServer:
          'smail'
      });


      console.log(
        `Lokalniot bootstrap admin vekje postoi: ${adminEmail}`
      );

      console.log(
        'Lozinkata i osnovnite podatoci se osvezeni.'
      );
    }


    /* =====================================================
       ASSIGN ADMIN ROLE THROUGH user_roles
    ===================================================== */

    const [, roleCreated] =
      await UserRole.findOrCreate({
        where: {
          userId:
            adminUser.userId,

          roleId:
            adminRole.roleId
        }
      });


    if (roleCreated) {
      console.log(
        'Admin ulogata e dodelena vo user_roles.'
      );
    } else {
      console.log(
        'Admin ulogata vekje e dodelena vo user_roles.'
      );
    }


    /* =====================================================
       FINISH
    ===================================================== */

    console.log(
      '\nInicijalizacija zavrshena.'
    );

    console.log(
      `Admin email: ${adminEmail}`
    );

    console.log(
      'Kreiran e lokalen bootstrap Admin account.'
    );

    console.log(
      'Sluzhba, Prodekan, Arhiva i dopolnitelni Admin roles se upravuvaat preku user_roles.\n'
    );


    process.exit(0);

  } catch (error) {

    console.error(
      'Greska pri inicijalizacija:',
      error
    );

    process.exit(1);
  }
};


initAdminAccount();