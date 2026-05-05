const fs = require('fs');
const path = require('path');
const os = require('os');

const logDir = path.join(__dirname, '..', 'logs');
const logFile = path.join(logDir, 'audit.csv');

function ensureLogFile() {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  if (!fs.existsSync(logFile)) {
    const header = 'timestamp,userId,email,role,ip,method,path,userAgent' + os.EOL;
    fs.writeFileSync(logFile, header);
  }
}

function escapeCsv(value) {
  if (value === undefined || value === null) return '""';
  const str = String(value);
  // double up quotes
  return '"' + str.replace(/"/g, '""') + '"';
}

module.exports = function auditLogger(req, res, next) {
  try {
    ensureLogFile();

    const timestamp = new Date().toISOString();
    const user = req.user || (req.session && req.session.user) || {};
    const userId = user.id || '';
    const email = user.email || user.mail || user.username || '';
    const role = user.role || user.roleLabel || '';
    const ip = (req.headers['x-forwarded-for'] || req.connection && req.connection.remoteAddress || req.ip || '').toString();
    const method = req.method;
    const url = req.originalUrl || req.url || '';
    const userAgent = req.headers['user-agent'] || '';

    const line = [timestamp, userId, email, role, ip, method, url, userAgent]
      .map(escapeCsv)
      .join(',') + os.EOL;

    fs.appendFile(logFile, line, (err) => {
      if (err) {
        console.error('Failed to write audit log:', err);
      }
    });
  } catch (err) {
    console.error('Audit logger error:', err);
  }

  next();
};
