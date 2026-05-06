const sequelize = require('../config/database');
const { Role } = require('../models');
const fs = require('fs');
const path = require('path');

const uploadsDir = path.join(__dirname, '..', 'uploads');

const deletePdfFilesRecursive = (dirPath) => {
  if (!fs.existsSync(dirPath)) return 0;

  let deletedCount = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      deletedCount += deletePdfFilesRecursive(fullPath);
      continue;
    }

    if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.pdf') {
      fs.unlinkSync(fullPath);
      deletedCount += 1;
      console.log(`Izbrisan PDF: ${fullPath}`);
    }
  }

  return deletedCount;
};

const resetDatabase = async () => {
  try {
    console.log('Pocnuva reset na baza...\n');

    const deletedPdfCount = deletePdfFilesRecursive(uploadsDir);
    console.log(`Izbrisani se ${deletedPdfCount} PDF fajlovi od uploads.\n`);

    console.log('Gi brisam i kreiram tabelite...\n');

    await sequelize.sync({ force: true });

    console.log('Tabelite se uspesno kreirani.\n');

    console.log('Kreiram osnovni roles...\n');

    const roles = [
      'Student',
      'Admin',
      'Sluzhba',
      'Prodekan',
      'Arhiva'
    ];

    for (const tip of roles) {
      await Role.create({ tip });
      console.log(`Kreirana uloga: ${tip}`);
    }

    console.log('\nBaza e uspesno resetirana.');
    console.log('Ne e kreiran lokalen admin account.');
    console.log('Ako ti treba bootstrap admin, pusti: npm run init-admin\n');

    process.exit(0);
  } catch (error) {
    console.error('Greska pri reset:', error.message);
    console.error(error);
    process.exit(1);
  }
};

resetDatabase();