const fs = require('fs');
const files = ['public/trades.html', 'public/index.html'];
files.forEach(file => {
  const c = fs.readFileSync(file, 'utf8');
  let pos = 0;
  let count = 0;
  const found = [];
  while ((pos = c.indexOf('99', pos)) !== -1) {
    const lineNo = c.substring(0, pos).split('\n').length;
    const line = c.split('\n')[lineNo-1];
    found.push({ line: lineNo, text: line.trim() });
    pos += 1;
    count++;
  }
  console.log(`\n=== ${file} ===`);
  console.log(`Total '99' occurrences: ${count}`);
  found.forEach(f => console.log(`  line ${f.line}: ${f.text.substring(0, 100)}`));
});