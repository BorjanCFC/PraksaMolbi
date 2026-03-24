const bcrypt = require('bcryptjs');
const sequelize = require('../config/database');
const Student = require('../models/Student');
const Molba = require('../models/Molba');

const seedData = async () => {
  try {
    // Sinhronizacija na bazata (force: true brise i rekreira tabeli)
    await sequelize.sync({ force: true });
    console.log('✅ Bazata e uspeshno sinhronizirana.');

    // Hashiranje na lozinki (site studenti imaat lozinka: "password123")
    const hashedPassword = await bcrypt.hash('password123', 10);

    // ===== SEED STUDENTI =====
    const studenti = await Student.bulkCreate([
      {
        ime: 'Марко',
        prezime: 'Петровски',
        brIndeks: '201001',
        email: 'marko.petrovski@student.mk',
        password: hashedPassword
      },
      {
        ime: 'Ана',
        prezime: 'Стојановска',
        brIndeks: '201002',
        email: 'ana.stojanovska@student.mk',
        password: hashedPassword
      },
      {
        ime: 'Стефан',
        prezime: 'Димитриевски',
        brIndeks: '201003',
        email: 'stefan.dimitrievski@student.mk',
        password: hashedPassword
      },
      {
        ime: 'Елена',
        prezime: 'Николовска',
        brIndeks: '201004',
        email: 'elena.nikolovska@student.mk',
        password: hashedPassword
      },
      {
        ime: 'Давид',
        prezime: 'Јованов',
        brIndeks: '201005',
        email: 'david.jovanov@student.mk',
        password: hashedPassword
      },
      {
        ime: 'Ивана',
        prezime: 'Ристовска',
        brIndeks: '201006',
        email: 'ivana.ristovska@student.mk',
        password: hashedPassword
      },
      {
        ime: 'Никола',
        prezime: 'Трајковски',
        brIndeks: '201007',
        email: 'nikola.trajkovski@student.mk',
        password: hashedPassword
      },
      {
        ime: 'Мила',
        prezime: 'Андреевска',
        brIndeks: '201008',
        email: 'mila.andreevska@student.mk',
        password: hashedPassword
      },
      {
        ime: 'Борјан',
        prezime: 'Георгиевски',
        brIndeks: '201009',
        email: 'borjan.georgievski@student.mk',
        password: hashedPassword
      },
      {
        ime: 'Тамара',
        prezime: 'Миленковска',
        brIndeks: '201010',
        email: 'tamara.milenkovska@student.mk',
        password: hashedPassword
      }
    ]);

    console.log(`✅ Uspeshno dodadeni ${studenti.length} studenti.`);

    // ===== SEED MOLBI =====
    const molbi = await Molba.bulkCreate([
      {
        studentId: 1,
        status: 'Во процес',
        datum: '2026-03-01',
        description: 'Молба за издавање на уверение за редовен студент за потребите на стипендија.',
        feedback: null
      },
      {
        studentId: 1,
        status: 'Одобрена',
        datum: '2026-02-15',
        description: 'Молба за промена на изборен предмет од Бази на податоци во Веб програмирање.',
        feedback: 'Молбата е одобрена. Промената е евидентирана во системот.'
      },
      {
        studentId: 2,
        status: 'Во процес',
        datum: '2026-03-03',
        description: 'Молба за одложување на испит по Математика 2 поради здравствени причини.',
        feedback: null
      },
      {
        studentId: 3,
        status: 'Одбиена',
        datum: '2026-02-20',
        description: 'Молба за признавање на предмет положен на друг факултет.',
        feedback: 'Молбата е одбиена бидејќи предметот не е еквивалентен со наставната програма. Потребна е дополнителна документација од матичниот факултет.'
      },
      {
        studentId: 4,
        status: 'Во процес',
        datum: '2026-03-05',
        description: 'Молба за издавање на потврда за завршени семестри за потребите на работодавач.',
        feedback: null
      },
      {
        studentId: 5,
        status: 'Одобрена',
        datum: '2026-01-25',
        description: 'Молба за продолжување на рок за предавање на семинарска работа по Оперативни системи.',
        feedback: 'Одобрено продолжување до 15.02.2026. Контактирајте го професорот за детали.'
      },
      {
        studentId: 6,
        status: 'Во процес',
        datum: '2026-03-04',
        description: 'Молба за запишување на предмети од повисок семестар како условни предмети.',
        feedback: null
      },
      {
        studentId: 7,
        status: 'Одбиена',
        datum: '2026-02-10',
        description: 'Молба за ослободување од плаќање на школарина за зимски семестар.',
        feedback: 'Молбата е одбиена. Студентот не ги исполнува условите за ослободување согласно правилникот (потребен просек над 9.0).'
      },
      {
        studentId: 8,
        status: 'Одобрена',
        datum: '2026-02-28',
        description: 'Молба за издавање на дупликат студентска легитимација поради загуба на оригиналот.',
        feedback: 'Одобрена. Подигнете ја новата легитимација од студентска служба со приложена уплатница.'
      },
      {
        studentId: 9,
        status: 'Во процес',
        datum: '2026-03-06',
        description: 'Молба за промена на лични податоци (адреса на живеење) во студентскиот досие.',
        feedback: null
      }
    ]);

    console.log(`✅ Uspeshno dodadeni ${molbi.length} molbi.`);

    console.log('\n========================================');
    console.log('  SEED ZAVRSEN USPESHNO!');
    console.log('========================================');
    console.log('\n--- STUDENT NAJAVA ---');
    console.log('Primer: marko.petrovski@student.mk / password123');
    console.log('\n--- ADMIN NAJAVA ---');
    console.log('Email: admin@university.mk');
    console.log('Lozinka: password123');
    console.log('URL: http://localhost:3000/admin/login');
    console.log('========================================\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Greska pri seeding:', error);
    process.exit(1);
  }
};

seedData();
