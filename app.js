require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const sequelize = require('./config/database');

const authRoutes = require('./routes/authRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

const ensureMolbaNaslovColumn = async () => {
  try {
    const [columns] = await sequelize.query("PRAGMA table_info('molbi');");
    const hasNaslov = Array.isArray(columns) && columns.some((col) => col.name === 'naslov');

    if (!hasNaslov) {
      await sequelize.query("ALTER TABLE molbi ADD COLUMN naslov VARCHAR(150) NOT NULL DEFAULT 'Без наслов';");
      console.log('✅ Dodadena e kolona "naslov" vo tabelata molbi.');
    }
  } catch (error) {
    console.warn('⚠️ Nastana problem pri proveruva na naslov kolona:', error.message);
  }
};

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));


app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')))

app.use(session({
  secret: process.env.SESSION_SECRET || 'default-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 2 } 
}));

app.use(flash());


app.use('/', authRoutes);
app.use('/', dashboardRoutes);

app.use((req, res) => {
  res.status(404).render('login', {
    title: 'Страницата не е пронајдена',
    error: 'Страницата не е пронајдена.',
    success: ''
  });
});


sequelize.sync().then(async () => {
  await ensureMolbaNaslovColumn();
  console.log('✅ Bazata e povrzana i sinhronizirana.');

  const server = app.listen(PORT, () => {
    console.log(`🚀 Serverot raboti na http://localhost:${PORT}`);
    console.log(`📋 Login: http://localhost:${PORT}/login`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} e zafaten. Oslobodi go toj port ili promeni PORT vo .env.`);
    } else {
      console.error('❌ Greska pri startuvanje na server:', err.message);
    }
    process.exit(1);
  });
}).catch((err) => {
  console.error('❌ Greska pri povrzuvanje so baza:', err);
});
