const sequelize = require('../config/database');
const { User, Molba, Student, Role } = require('../models');
const bcrypt = require('bcryptjs');

const resetDatabase = async () => {
  try {
    console.log('🔄 Počnuva reset na baza...\n');

    // List of all tables to drop
    const tables = ['Molbas', 'Students', 'Users', 'Roles'];

    // Drop tables explicitly with cascade
    for (const table of tables) {
      try {
        await sequelize.getQueryInterface().dropTable(table, { cascade: true });
        console.log(`✅ Tabela "${table}" izbrisana.`);
      } catch (err) {
        console.log(`⚠️  Tabela "${table}" ne postoi ili greška: ${err.message}`);
      }
    }

    console.log('\n🔧 Kreiram nove tabele...\n');
    await sequelize.sync({ force: true });
    console.log('✅ Nove tabele kreirane.\n');

    // Create default roles
    console.log('📋 Kreiram roles...');
    const adminRole = await Role.create({
      tip: 'Admin'
    });
    console.log('✅ Admin roles kreirana.');

    const studentRole = await Role.create({
      tip: 'Student'
    });
    console.log('✅ Student roles kreirana.\n');

    // Create admin user
    console.log('👤 Kreiram admin korisnik...');
    const hashedPassword = await bcrypt.hash('password123', 10);
    const adminUser = await User.create({
      ime: 'Админ',
      prezime: 'Систем',
      email: 'admin@university.mk',
      password: hashedPassword,
      roleId: adminRole.roleId,
      provider: 'local'
    });
    console.log('✅ Admin korisnik kreiran (admin@university.mk / password123)\n');

    console.log('✨ Baza e uspesno resetirana!\n');
    process.exit(0);
  } catch (error) {
    console.error('❌ Greška pri resetu:', error.message);
    console.error(error);
    process.exit(1);
  }
};

resetDatabase();
