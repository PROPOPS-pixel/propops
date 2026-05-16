const fs = require('fs');
const c = fs.readFileSync('public/index.html', 'utf8');
const matches = c.match(/<h4>(.*?)<\/h4>/g);
console.log('FAQ Questions found:', matches ? matches.length : 0);
if (matches) matches.forEach(m => console.log(m));