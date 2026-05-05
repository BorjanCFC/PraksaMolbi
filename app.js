require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const fs = require('fs');
const sequelize = require('./config/database');
const { isEntraConfigured } = require('./config/entraAuth');

const authRoutes = require('./routes/authRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const auditLogger = require('./middlewares/auditLogger');

const app = express();
const PORT = process.env.PORT || 3000;

const ensureUploadDirectories = () => {
  const folders = [
    path.join(__dirname, 'uploads'),
    path.join(__dirname, 'uploads', 'student'),
    path.join(__dirname, 'uploads', 'archive')
  ];

  folders.forEach((folder) => {
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }
  });
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

// Audit logger: records who did what, when, from which IP
app.use(auditLogger);


app.use('/', authRoutes);
app.use('/', dashboardRoutes);

app.use((error, req, res, next) => {
  if (error && error.message) {
    req.flash('error', error.message);
    return res.redirect('back');
  }
  return next();
});

app.use((req, res) => {
  res.status(404).render('login', {
    title: 'Страницата не е пронајдена',
    error: 'Страницата не е пронајдена.',
    success: '',
    entraEnabled: isEntraConfigured()
  });
});


ensureUploadDirectories();

sequelize.sync({ alter: true }).then(async () => {
  console.log('Bazata e povrzana i sinhronizirana.');

  const server = app.listen(PORT, () => {
    console.log(`Serverot raboti na http://localhost:${PORT}`);
    console.log(`Login: http://localhost:${PORT}/login`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} e zafaten. Oslobodi go toj port ili promeni PORT vo .env.`);
    } else {
      console.error('Greska pri startuvanje na server:', err.message);
    }
    process.exit(1);
  });
}).catch((err) => {
  console.error('Greska pri povrzuvanje so baza:', err);
});
