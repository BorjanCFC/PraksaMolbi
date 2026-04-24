require('dotenv').config();
const bcrypt = require('bcryptjs');
const sequelize = require('../config/database');
const { User, Role } = require('../models');

const initAdminAccounts = async () => {
  try {
    await sequelize.sync({ alter: true });
    console.log('✅ Bazata sinhronizirana.');

    const roles = [
      { tip: 'Student' },
      { tip: 'Admin' },
      { tip: 'Sluzhba' },
      { tip: 'Prodekan' },
      { tip: 'Arhiva' }
    ];

    for (const roleData of roles) {
      const [role, created] = await Role.findOrCreate({
        where: { tip: roleData.tip },
        defaults: { tip: roleData.tip }
      });
      if (created) {
        console.log(`✅ Kreirana uloga: ${role.tip}`);
      }
    }

    const adminConfigs = [
      {
        envPrefix: 'ADMIN',
        tip: 'Admin',
        defaultEmail: 'admin@university.mk',
        defaultPassword: 'admin123',
        defaultIme: 'Админ',
        defaultPrezime: 'Глобален'
      },
      {
        envPrefix: 'SLUZHBA',
        tip: 'Sluzhba',
        defaultEmail: 'sluzhba@university.mk',
        defaultPassword: 'sluzhba123',
        defaultIme: 'Служба',
        defaultPrezime: 'Оператор'
      },
      {
        envPrefix: 'PRODEKAN',
        tip: 'Prodekan',
        defaultEmail: 'prodekan@university.mk',
        defaultPassword: 'prodekan123',
        defaultIme: 'Продекан',
        defaultPrezime: 'ФЕИТ'
      },
      {
        envPrefix: 'ARHIVA',
        tip: 'Arhiva',
        defaultEmail: 'arhiva@university.mk',
        defaultPassword: 'arhiva123',
        defaultIme: 'Архива',
        defaultPrezime: 'Оператор'
      }
    ];

    for (const config of adminConfigs) {
      const email = (process.env[`${config.envPrefix}_EMAIL`] || config.defaultEmail).toLowerCase().trim();
      const password = process.env[`${config.envPrefix}_PASSWORD`] || config.defaultPassword;
      const ime = process.env[`${config.envPrefix}_IME`] || config.defaultIme;
      const prezime = process.env[`${config.envPrefix}_PREZIME`] || config.defaultPrezime;

      const role = await Role.findOne({ where: { tip: config.tip } });
      if (!role) {
        console.warn(`⚠️ Uloga ${config.tip} ne postoi.`);
        continue;
      }

      const [user, created] = await User.findOrCreate({
        where: { email },
        defaults: {
          ime,
          prezime,
          email,
          password: await bcrypt.hash(password, 10),
          roleId: role.roleId,
          provider: 'local',
          providerId: null
        }
      });

      if (created) {
        console.log(`✅ Kreiran akaunt: ${email} (${config.tip})`);
      } else {
        console.log(`ℹ️ Akaunt vekje postoi: ${email}`);
      }
    }

    console.log('\n✅ Inicijalizacija zavrshena!');
    console.log('\n--- LOGIN AKAUNTI ---');
    console.log('Entra Login (Studenti): Klikni na "Najava so Microsoft Entra" dugme');
    console.log(`Admin: ${process.env.ADMIN_EMAIL || 'admin@university.mk'} / ${process.env.ADMIN_PASSWORD || 'admin123'}`);
    console.log(`Sluzhba: ${process.env.SLUZHBA_EMAIL || 'sluzhba@university.mk'} / ${process.env.SLUZHBA_PASSWORD || 'sluzhba123'}`);
    console.log(`Prodekan: ${process.env.PRODEKAN_EMAIL || 'prodekan@university.mk'} / ${process.env.PRODEKAN_PASSWORD || 'prodekan123'}`);
    console.log(`Arhiva: ${process.env.ARHIVA_EMAIL || 'arhiva@university.mk'} / ${process.env.ARHIVA_PASSWORD || 'arhiva123'}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Greska pri inicijalizacija:', error);
    process.exit(1);
  }
};

initAdminAccounts();
