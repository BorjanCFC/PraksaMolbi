const path = require('path');

/**
 * Convert Cyrillic to Latin for folder names
 * Maps Macedonian Cyrillic characters to their Latin equivalents
 */
const cyrillicToLatin = {
  'А': 'A', 'а': 'a',
  'Б': 'B', 'б': 'b',
  'В': 'V', 'в': 'v',
  'Г': 'G', 'г': 'g',
  'Д': 'D', 'д': 'd',
  'Е': 'E', 'е': 'e',
  'Ж': 'Zh', 'ж': 'zh',
  'З': 'Z', 'з': 'z',
  'И': 'I', 'и': 'i',
  'Ј': 'J', 'ј': 'j',
  'К': 'K', 'к': 'k',
  'Л': 'L', 'л': 'l',
  'Љ': 'Lj', 'љ': 'lj',
  'М': 'M', 'м': 'm',
  'Н': 'N', 'н': 'n',
  'Њ': 'Nj', 'њ': 'nj',
  'О': 'O', 'о': 'o',
  'П': 'P', 'п': 'p',
  'Р': 'R', 'р': 'r',
  'С': 'S', 'с': 's',
  'Т': 'T', 'т': 't',
  'Ќ': 'Kj', 'ќ': 'kj',
  'У': 'U', 'у': 'u',
  'Ф': 'F', 'ф': 'f',
  'Х': 'H', 'х': 'h',
  'Ц': 'Ts', 'ц': 'ts',
  'Ч': 'Ch', 'ч': 'ch',
  'Ш': 'Sh', 'ш': 'sh',
  'Џ': 'Dzh', 'џ': 'dzh'
};

/**
 * Convert a string from Cyrillic to Latin
 * @param {string} text - Text to convert
 * @returns {string} - Converted text
 */
const convertCyrillicToLatin = (text) => {
  if (!text) return '';
  
  let result = '';
  let i = 0;
  
  while (i < text.length) {
    // Check for two-character combinations first
    if (i + 1 < text.length) {
      const twoChar = text.substr(i, 2);
      if (cyrillicToLatin[twoChar]) {
        result += cyrillicToLatin[twoChar];
        i += 2;
        continue;
      }
    }
    
    // Check single character
    const char = text[i];
    if (cyrillicToLatin[char]) {
      result += cyrillicToLatin[char];
    } else {
      result += char;
    }
    i++;
  }
  
  return result;
};

/**
 * Generate a safe folder name from a string
 * Converts to lowercase, replaces spaces and special chars with hyphens
 * Converts Cyrillic to Latin
 */
const generateSafeFolderName = (name) => {
  if (!name) return 'unknown';
  
  // First convert Cyrillic to Latin
  let converted = convertCyrillicToLatin(name);
  
  return converted
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

/**
 * Get the academic year in format YYYY-YY based on current date
 * Example: May 2026 returns "2025-26"
 */
const getAcademicYear = () => {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  
  // Academic year starts in September (month 9)
  // If current month is September or later, academic year starts this year
  // If current month is before September, academic year started last year
  if (month >= 9) {
    return `${year}-${(year + 1) % 100}`;
  } else {
    return `${year - 1}-${year % 100}`;
  }
};

/**
 * Generate organized upload path for student documents
 * Structure: uploads/student/YYYY-YY/nasoka/student-name/
 * 
 * @param {string} nasoka - Field/direction (насока) - e.g., "КТИ"
 * @param {string} studentIme - Student first name
 * @param {string} studentPrezime - Student last name
 * @returns {string} - Relative path like "student/2025-26/kti/borjan-petrevski"
 */
const getStudentDocumentPath = (nasoka, studentIme, studentPrezime) => {
  const academicYear = getAcademicYear();
  const nasokaFolder = generateSafeFolderName(nasoka);
  const studentFolder = generateSafeFolderName(`${studentIme} ${studentPrezime}`);
  
  return path.join('student', academicYear, nasokaFolder, studentFolder);
};

/**
 * Generate organized archive path for generated PDFs
 * Structure: uploads/archive/YYYY-YY/nasoka/student-name/
 * 
 * @param {string} nasoka - Field/direction (насока) - e.g., "КТИ"
 * @param {string} studentIme - Student first name
 * @param {string} studentPrezime - Student last name
 * @returns {string} - Relative path like "archive/2025-26/kti/borjan-petrevski"
 */
const getArchivePath = (nasoka, studentIme, studentPrezime) => {
  const academicYear = getAcademicYear();
  const nasokaFolder = generateSafeFolderName(nasoka);
  const studentFolder = generateSafeFolderName(`${studentIme} ${studentPrezime}`);
  
  return path.join('archive', academicYear, nasokaFolder, studentFolder);
};

module.exports = {
  generateSafeFolderName,
  getAcademicYear,
  getStudentDocumentPath,
  getArchivePath
};
