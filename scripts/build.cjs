'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

function replaceOnce(source, expression, value) {
  assert.equal(source.split(expression).length, 2, `Expected one occurrence of ${expression}`);
  return source.replace(expression, () => value);
}

function embedModule(name, source) {
  return `const ${name} = (() => {
const module = { exports: {} };
${source}
return module.exports;
})();`;
}

const manifest = read('plugin.json');
const settings = JSON.stringify(JSON.parse(read('settings.json')));
const page = JSON.stringify(read('diagnostics.html'));
const comparison = embedModule('bundledComparison', read('comparison.cjs'));
const diagnostics = embedModule('bundledDiagnostics', replaceOnce(
  read('diagnostics.cjs'), "require('./comparison.cjs')", 'bundledComparison',
));
let entry = read('index.cjs');
for (const [expression, value] of [
  ["require('./diagnostics.cjs')", 'bundledDiagnostics'],
  ["require('./plugin.json')", JSON.stringify(JSON.parse(manifest))],
  ["JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8'))", settings],
  ["fs.readFileSync(path.join(__dirname, 'diagnostics.html'), 'utf8')", page],
  ["const fs = require('node:fs');\n", ''],
  ["const path = require('node:path');\n", ''],
]) {
  entry = replaceOnce(entry, expression, value);
}
const bundle = ["'use strict';", comparison, diagnostics, entry].join('\n\n');
const hash = createHash('sha256').update(bundle).digest('hex');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'index.cjs'), bundle);
fs.writeFileSync(path.join(dist, 'plugin.json'), manifest);
fs.writeFileSync(path.join(dist, 'index.cjs.sha256'), `${hash}  index.cjs\n`);
