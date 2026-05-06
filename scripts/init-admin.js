require('dotenv').config();

const bcrypt = require('bcryptjs');
const sequelize = require('../config/database');
const { User, Role } = require('../models');

const initAdminAccount = async () => {
  try {
    await sequelize.sync({ alter: true });
    console.log('Bazata e sinhronizirana.');

    const roles = [
      'Student',
      'Admin',
      'Sluzhba',
      'Prodekan',
      'Arhiva'
    ];

    for (const tip of roles) {
      const [role, created] = await Role.findOrCreate({
        where: { tip },
        defaults: { tip }
      });

      if (created) {
        console.log(`Kreirana uloga: ${role.tip}`);
      }
    }

    const adminEmail = (
      process.env.ADMIN_EMAIL || 'admin@university.mk'
    ).toLowerCase().trim();

    const adminPassword =
      process.env.ADMIN_PASSWORD || 'admin123';

    const adminIme =
      process.env.ADMIN_IME || 'Админ';

    const adminPrezime =
      process.env.ADMIN_PREZIME || 'Глобален';

    const adminRole = await Role.findOne({
      where: { tip: 'Admin' }
    });

    if (!adminRole) {
      console.error('Ne postoi Admin uloga vo bazata.');
      process.exit(1);
    }

    const [adminUser, created] = await User.findOrCreate({
      where: {
        email: adminEmail,
        provider: 'local'
      },
      defaults: {
        ime: adminIme,
        prezime: adminPrezime,
        email: adminEmail,
        password: await bcrypt.hash(adminPassword, 10),
        roleId: adminRole.roleId,
        provider: 'local',
        providerId: null,
        authServer: 'smail'
      }
    });

    if (created) {
      console.log(`Kreiran lokalen bootstrap admin: ${adminEmail}`);
    } else {
      console.log(`Lokalniot bootstrap admin vekje postoi: ${adminEmail}`);
    }

    console.log('\nInicijalizacija zavrshena.');
    console.log('Kreiran e samo lokalen Admin account.');
    console.log('Sluzhba, Prodekan, Arhiva i dopolnitelni Admin accounts treba da se dodadat preku dashboard so provider feit_pop3.\n');

    process.exit(0);
  } catch (error) {
    console.error('Greska pri inicijalizacija:', error);
    process.exit(1);
  }
};

initAdminAccount();