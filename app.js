require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const sequelize = require('./config/database');

// Import routes
const authRoutes = require('./routes/authRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const adminRoutes = require('./routes/adminRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== VIEW ENGINE =====
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ===== MIDDLEWARE =====
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'default-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 2 } // 2 casa
}));

// Flash messages
app.use(flash());

// ===== ROUTES =====
app.use('/', authRoutes);
app.use('/', dashboardRoutes);
app.use('/', adminRoutes);

// 404
app.use((req, res) => {
  res.status(404).render('login', {
    title: 'Страницата не е пронајдена',
    error: 'Страницата не е пронајдена.',
    success: ''
  });
});

// ===== DATABASE SYNC & SERVER START =====
sequelize.sync().then(() => {
  console.log('✅ Bazata e povrzana i sinhronizirana.');
  app.listen(PORT, () => {
    console.log(`🚀 Serverot raboti na http://localhost:${PORT}`);
    console.log(`📋 Login: http://localhost:${PORT}/login`);
  });
}).catch((err) => {
  console.error('❌ Greska pri povrzuvanje so baza:', err);
});
