/**
 * Convert Latin Macedonian names to Cyrillic.
 * Kept for backward compatibility with older user rows that may still
 * contain Latin-script names.
 */
const latinToCyrillic = {
  'A': 'А', 'a': 'а',
  'B': 'Б', 'b': 'б',
  'C': 'Ц', 'c': 'ц',
  'Ch': 'Ч', 'ch': 'ч',
  'D': 'Д', 'd': 'д',
  'Dj': 'Џ', 'dj': 'џ',
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
  'Sh': 'Ш', 'sh': 'ш',
  'T': 'Т', 't': 'т',
  'U': 'У', 'u': 'у',
  'V': 'В', 'v': 'в',
  'Z': 'З', 'z': 'з',
  'Zh': 'Ж', 'zh': 'ж'
};

const convertNameToCyrillic = (latinName) => {
  if (!latinName) return latinName;

  let cyrillic = '';
  let i = 0;

  while (i < latinName.length) {
    if (i + 1 < latinName.length) {
      const twoChar = latinName.substr(i, 2);
      if (latinToCyrillic[twoChar]) {
        cyrillic += latinToCyrillic[twoChar];
        i += 2;
        continue;
      }
    }

    const char = latinName[i];
    cyrillic += latinToCyrillic[char] || char;
    i += 1;
  }

  return cyrillic;
};

/* =========================================================
   MOLBI_STUDENT_REQUEST_NUMBERING_PDF_NAMES_V1
   Macedonian Cyrillic -> filesystem-friendly Latin ASCII
========================================================= */
const cyrillicToLatin = {
  'А': 'A',  'а': 'a',
  'Б': 'B',  'б': 'b',
  'В': 'V',  'в': 'v',
  'Г': 'G',  'г': 'g',
  'Д': 'D',  'д': 'd',
  'Ѓ': 'Gj', 'ѓ': 'gj',
  'Е': 'E',  'е': 'e',
  'Ж': 'Zh', 'ж': 'zh',
  'З': 'Z',  'з': 'z',
  'Ѕ': 'Dz', 'ѕ': 'dz',
  'И': 'I',  'и': 'i',
  'Ј': 'J',  'ј': 'j',
  'К': 'K',  'к': 'k',
  'Л': 'L',  'л': 'l',
  'Љ': 'Lj', 'љ': 'lj',
  'М': 'M',  'м': 'm',
  'Н': 'N',  'н': 'n',
  'Њ': 'Nj', 'њ': 'nj',
  'О': 'O',  'о': 'o',
  'П': 'P',  'п': 'p',
  'Р': 'R',  'р': 'r',
  'С': 'S',  'с': 's',
  'Т': 'T',  'т': 't',
  'Ќ': 'Kj', 'ќ': 'kj',
  'У': 'U',  'у': 'u',
  'Ф': 'F',  'ф': 'f',
  'Х': 'H',  'х': 'h',
  'Ц': 'C',  'ц': 'c',
  'Ч': 'Ch', 'ч': 'ch',
  'Џ': 'Dj', 'џ': 'dj',
  'Ш': 'Sh', 'ш': 'sh'
};

/**
 * Converts Macedonian Cyrillic to Latin ASCII.
 * Existing Latin characters are left unchanged, so this also works with
 * legacy users whose names are already stored in Latin script.
 */
const convertNameToLatin = (value) => {
  if (!value) return value;

  return Array.from(String(value))
    .map((char) => cyrillicToLatin[char] || char)
    .join('');
};

module.exports = {
  convertNameToCyrillic,
  convertNameToLatin
};
