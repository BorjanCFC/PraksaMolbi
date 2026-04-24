const sequelize = require('../config/database');
const {
  User,
  Molba,
  Student,
  Role
} = require('../models');

const seedData = async () => {
  try {
    const queryInterface = sequelize.getQueryInterface();
    const tablesToDrop = [
      'molbi',
      'students',
      'users',
      'roles',
      'student_profiles',
      'admin_profiles',
      'studentska_sluzhba_profiles',
      'prodekan_profiles',
      'arhiva_profiles'
    ];

    for (const tableName of tablesToDrop) {
      try {
        await queryInterface.dropTable(tableName, { cascade: true });
      } catch (error) {
        // Ignore missing tables during reset.
      }
    }

    await sequelize.sync({ force: true });
    console.log('✅ Bazata e uspeshno resetirana i sinhronizirana.');

    const roles = await Role.bulkCreate([
      { tip: 'Student' },
      { tip: 'Admin' },
      { tip: 'Sluzhba' },
      { tip: 'Prodekan' },
      { tip: 'Arhiva' }
    ], { returning: true });

    const roleByTip = new Map(roles.map((role) => [role.tip, role]));

    const users = await User.bulkCreate([
      {
        ime: 'Марко',
        prezime: 'Петровски',
        email: 'marko.petrovski@student.mk',
        password: null,
        provider: 'microsoft',
        providerId: null,
        roleId: roleByTip.get('Student').roleId
      },
      {
        ime: 'Ана',
        prezime: 'Стојановска',
        email: 'ana.stojanovska@student.mk',
        password: null,
        provider: 'microsoft',
        providerId: null,
        roleId: roleByTip.get('Student').roleId
      },
      {
        ime: 'Стефан',
        prezime: 'Димитриевски',
        email: 'stefan.dimitrievski@student.mk',
        password: null,
        provider: 'microsoft',
        providerId: null,
        roleId: roleByTip.get('Student').roleId
      },
      {
        ime: 'Елена',
        prezime: 'Николовска',
        email: 'elena.nikolovska@student.mk',
        password: null,
        provider: 'microsoft',
        providerId: null,
        roleId: roleByTip.get('Student').roleId
      }
    ]);

    const studentOne = users.find((u) => u.email === 'marko.petrovski@student.mk');
    const studentTwo = users.find((u) => u.email === 'ana.stojanovska@student.mk');
    const studentThree = users.find((u) => u.email === 'stefan.dimitrievski@student.mk');
    const studentFour = users.find((u) => u.email === 'elena.nikolovska@student.mk');

    await Student.bulkCreate([
      { userId: studentOne.userId, brIndeks: '201001', smer: 'КН' },
      { userId: studentTwo.userId, brIndeks: '201002', smer: 'ЕЕ' },
      { userId: studentThree.userId, brIndeks: '201003', smer: 'АУС' },
      { userId: studentFour.userId, brIndeks: '201004', smer: 'ТКИ' }
    ]);

    const molbi = await Molba.bulkCreate([
      {
        userId: studentOne.userId,
        status: 'Во процес',
        datum: '2026-03-01',
        naslov: 'Молба за уверение',
        semestar: 'Зимски',
        ucebnaGodina: '2025/2026',
        description: 'Молба за издавање на уверение за редовен студент за потребите на стипендија.',
        arhivskiBroj: 'ARH-MOL-2026-0101',
        urlPath: 'uploads/student/seed-molba-1.pdf',
        feedback: 'Молбата е примена и е во тек на обработка.'
      },
      {
        userId: studentOne.userId,
        status: 'Одобрена',
        datum: '2026-02-15',
        naslov: 'Молба за промена на предмет',
        semestar: 'Летен',
        ucebnaGodina: '2025/2026',
        description: 'Молба за промена на изборен предмет од Бази на податоци во Веб програмирање.',
        arhivskiBroj: 'ARH-MOL-2026-0102',
        urlPath: 'uploads/student/seed-molba-2.pdf',
        feedback: 'Молбата е одобрена. Промената е евидентирана во системот.'
      },
      {
        userId: studentTwo.userId,
        status: 'Во процес',
        datum: '2026-03-03',
        naslov: 'Молба за одложување испит',
        semestar: 'Зимски',
        ucebnaGodina: '2025/2026',
        description: 'Молба за одложување на испит по Математика 2 поради здравствени причини.',
        arhivskiBroj: 'ARH-MOL-2026-0103',
        urlPath: 'uploads/student/seed-molba-3.pdf',
        feedback: 'Молбата е примена и е во тек на обработка.'
      },
      {
        userId: studentThree.userId,
        status: 'Одбиена',
        datum: '2026-02-20',
        naslov: 'Молба за признавање предмет',
        semestar: 'Летен',
        ucebnaGodina: '2025/2026',
        description: 'Молба за признавање на предмет положен на друг факултет.',
        arhivskiBroj: 'ARH-MOL-2026-0104',
        urlPath: 'uploads/student/seed-molba-4.pdf',
        feedback: 'Молбата е одбиена поради нееквивалентна наставна програма.'
      },
      {
        userId: studentFour.userId,
        status: 'Во процес',
        datum: '2026-03-05',
        naslov: 'Молба за потврда',
        semestar: 'Зимски',
        ucebnaGodina: '2025/2026',
        description: 'Молба за издавање на потврда за завршени семестри за потребите на работодавач.',
        arhivskiBroj: 'ARH-MOL-2026-0105',
        urlPath: 'uploads/student/seed-molba-5.pdf',
        feedback: 'Молбата е примена и е во тек на обработка.'
      }
    ]);

    console.log(`✅ Uspeshno dodadeni ${roles.length} roles.`);
    console.log(`✅ Uspeshno dodadeni ${users.length} korisnici.`);
    console.log(`✅ Uspeshno dodadeni ${molbi.length} molbi.`);

    console.log('\n========================================');
    console.log('  SEED ZAVRSEN USPESHNO!');
    console.log('========================================');
    console.log('\n--- LOGIN AKAUNTI ---');
    console.log('Student: marko.petrovski@student.mk (Microsoft Entra login)');
    console.log('Lokalni admin/service accounts se kreiraat od .env so npm run init-admin');
    console.log('========================================\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Greska pri seeding:', error);
    process.exit(1);
  }
};

seedData();
