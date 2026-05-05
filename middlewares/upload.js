const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { getStudentDocumentPath } = require('../utils/uploadPathHelper');

const allowedMimeTypes = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp'
]);

const pdfOnlyMimeTypes = new Set(['application/pdf']);

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const createStorage = (subFolder) => multer.diskStorage({
  destination: (req, file, cb) => {
    console.log('[Multer.destination] req.body:', req.body);
    console.log('[Multer.destination] req.session.user:', req.session?.user?.ime, req.session?.user?.prezime);
    
    // For student uploads with organized structure
    if (req.body && req.body.smer && req.session && req.session.user) {
      const nasoka = req.body.smer;
      const studentIme = req.session.user.ime;
      const studentPrezime = req.session.user.prezime;
      
      console.log('[Multer.destination] Creating organized path for:', { nasoka, studentIme, studentPrezime });
      
      const relPath = getStudentDocumentPath(nasoka, studentIme, studentPrezime);
      const uploadDir = path.join(__dirname, '..', 'uploads', relPath);
      
      console.log('[Multer.destination] Organized upload dir:', uploadDir);
      
      ensureDir(uploadDir);
      cb(null, uploadDir);
    } else {
      // Fallback for non-organized uploads
      const uploadDir = path.join(__dirname, '..', 'uploads', subFolder);
      console.log('[Multer.destination] Fallback upload dir:', uploadDir);
      ensureDir(uploadDir);
      cb(null, uploadDir);
    }
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '');
    cb(null, `${Date.now()}-${safeName}`);
  }
});

const createFileFilter = (mimeTypes, errorMessage) => (req, file, cb) => {
  if (!mimeTypes.has(file.mimetype)) {
    return cb(new Error(errorMessage));
  }
  return cb(null, true);
};

const createUploader = (subFolder, options = {}) => multer({
  storage: createStorage(subFolder),
  fileFilter: createFileFilter(
    options.allowedMimeTypes || allowedMimeTypes,
    options.errorMessage || 'Дозволени се само PDF и слики (PNG/JPG/WEBP).'
  ),
  limits: {
    fileSize: 15 * 1024 * 1024
  }
});

module.exports = {
  studentDocumentUpload: createUploader('student'),
  studentPdfUpload: createUploader('student', {
    allowedMimeTypes: pdfOnlyMimeTypes,
    errorMessage: 'Дозволен е само PDF документ.'
  })
};
