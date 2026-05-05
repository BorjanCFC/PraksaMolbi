const fs = require('fs');
const content = fs.readFileSync('./controllers/molbiController.js', 'utf8');

// Replace the four header text blocks with a single consolidated block
let updated = content;

// Replace fontSize(14) header texts with single fontSize(12) block
const lines = updated.split('\n');
const result = [];
let i = 0;

while (i < lines.length) {
  if (lines[i].includes('const headerX = 140;')) {
    result.push('    const headerX = 130;');
    i++;
  } else if (lines[i].includes('const headerWidth = 315;')) {
    result.push('    const headerWidth = 340;');
    i++;
  } else if (lines[i].includes("doc.font(boldFont).fontSize(14).text('УНИВЕРЗИТЕТ")) {
    // Found start of header block - skip 4 header text calls
    result.push('    doc.font(boldFont).fontSize(12).text(');
    result.push('      \'УНИВЕРЗИТЕТ "Св. КИРИЛ И\\nМЕТОДИЈ" - СКОПЈЕ\\n\\nФАКУЛТЕТ ЗА ЕЛЕКТРОТЕХНИКА И\\nИНФОРМАЦИСКИ ТЕХНОЛОГИИ\',');
    result.push('      headerX,');
    result.push('      55,');
    result.push('      {');
    result.push('        width: headerWidth,');
    result.push('        align: \'center\',');
    result.push('        lineGap: 2');
    result.push('      }');
    result.push('    );');
    
    // Skip the old 4-line header blocks
    while (i < lines.length && !lines[i].includes('doc.font(boldFont).fontSize(13).text(\'Датум:\'')) {
      i++;
    }
  } else {
    result.push(lines[i]);
    i++;
  }
}

const finalContent = result.join('\n');
fs.writeFileSync('./controllers/molbiController.js', finalContent, 'utf8');
console.log('✓ PDF layout fixes applied successfully');
