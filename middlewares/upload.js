const fs = require('fs');
const path = require('path');
const multer = require('multer');

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
    const uploadDir = path.join(__dirname, '..', 'uploads', subFolder);
    ensureDir(uploadDir);
    cb(null, uploadDir);
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
