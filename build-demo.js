// Builds dist/demo.html: a single self-contained file that runs the agent on a simulated market in the browser.
const fs = require('fs'), path = require('path');
const r = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
let html = r('public/index.html')
  .replace('<link rel="stylesheet" href="style.css">', () => `<style>\n${r('public/style.css')}\n</style>`)
  .replace('<script src="core.js"></script>', () => `<script>window.__DEMO__ = true;</script>\n<script>\n${r('core.js')}\n</script>`)
  .replace('<script src="app.js"></script>', () => `<script>\n${r('public/app.js')}\n</script>`);
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist/demo.html'), html);
console.log('Wrote dist/demo.html (' + Math.round(html.length / 1024) + ' KB)');
