/**
 * Convert Latin Macedonian names to Cyrillic
 */
const latinToCyrillic = {
  'A': 'А', 'a': 'а',
  'B': 'Б', 'b': 'б',
  'C': 'Ц', 'c': 'ц',
  'Č': 'Ч', 'č': 'ч',
  'D': 'Д', 'd': 'д',
  'Dž': 'Џ', 'dž': 'џ',
  'Đ': 'Ђ', 'đ': 'ђ',
  'E': 'Е', 'e': 'е',
  'F': 'Ф', 'f': 'ф',
  'G': 'Г', 'g': 'г',
  'H': 'Х', 'h': 'х',
  'I': 'И', 'i': 'и',
  'J': 'Ј', 'j': 'ј',
  'K': 'К', 'k': 'к',
  'L': 'Л', 'l': 'л',
  'Lj': 'Љ', 'lj': 'љ',
  'M': 'М', 'm': 'м',
  'N': 'Н', 'n': 'н',
  'Nj': 'Њ', 'nj': 'њ',
  'O': 'О', 'o': 'о',
  'P': 'П', 'p': 'п',
  'R': 'Р', 'r': 'р',
  'S': 'С', 's': 'с',
  'Š': 'Ш', 'š': 'ш',
  'T': 'Т', 't': 'т',
  'U': 'У', 'u': 'у',
  'V': 'В', 'v': 'в',
  'Z': 'З', 'z': 'з',
  'Ž': 'Ж', 'ž': 'ж'
};

/**
 * Convert a Macedonian name from Latin to Cyrillic script
 * @param {string} latinName - Name in Latin script
 * @returns {string} - Name converted to Cyrillic script
 */
const convertNameToCyrillic = (latinName) => {
  if (!latinName) return latinName;
  
  let cyrillic = '';
  let i = 0;
  
  while (i < latinName.length) {
    // Check for two-character combinations first (Dž, Lj, Nj, Č, Š, Ž, etc.)
    if (i + 1 < latinName.length) {
      const twoChar = latinName.substr(i, 2);
      if (latinToCyrillic[twoChar]) {
        cyrillic += latinToCyrillic[twoChar];
        i += 2;
        continue;
      }
    }
    
    // Check single character
    const char = latinName[i];
    if (latinToCyrillic[char]) {
      cyrillic += latinToCyrillic[char];
    } else {
      // If no conversion found, keep the original character
      cyrillic += char;
    }
    i++;
  }
  
  return cyrillic;
};

module.exports = {
  convertNameToCyrillic
};
