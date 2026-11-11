const fs = require('fs');
const path = 'c:\\xampp\\htdocs\\OIBL_SCHEMES\\app.js';
let text = fs.readFileSync(path, 'utf8');
const anchor = "app.post('/bdo/schemes/create/:prospectId', requireAuth, async (req, res) => {";
const start = text.indexOf("app.get('/bdo/schemes/create/:prospectId', requireAuth, async (req, res) => {", text.indexOf(anchor));
const end = text.indexOf("app.get('/bdo/schemes', requireAuth, async (req, res) => {", start);
if (start === -1 || end === -1) {
  console.log('duplicate block not found');
  process.exit(0);
}
text = text.slice(0, start) + text.slice(end);
fs.writeFileSync(path, text, 'utf8');
console.log('duplicate block removed');
