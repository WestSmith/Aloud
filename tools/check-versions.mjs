import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const version = read('index.html').match(/name="aloud-version" content="v(\d+\.\d+\.\d+)"/)?.[1];
assert(version, 'Missing app version');
assert.equal(read('sw.js').match(/const VERSION = '([^']+)'/)?.[1], 'aloud-v' + version, 'worker cache version drift');
assert.equal(read('ios/Aloud.swiftpm/Package.swift').match(/displayVersion: "([^"]+)"/)?.[1], version, 'native display version drift');
assert.equal(read('ios/README.md').match(/Aloud v(\d+\.\d+\.\d+)/)?.[1], version, 'iOS README release drift');
for (const file of fs.readdirSync(path.join(root, '.github/workflows'))) {
  for (const match of read('.github/workflows/' + file).matchAll(/uses:\s*([^\s#]+)/g))
    assert(/@[0-9a-f]{40}$/.test(match[1]), 'Unpinned action: ' + match[1]);
}
const notices = read('ios/Aloud.swiftpm/ThirdPartyLicenses.txt');
const escaped = notices.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#x27;');
assert(read('index.html').includes(escaped), 'Inline and bundled complete license texts differ');
assert(read('ios/Aloud.swiftpm/Package.swift').includes('.copy("ThirdPartyLicenses.txt")'), 'Native licenses are not packaged');
const normalized = notices.toLowerCase().replace(/[^a-z0-9]/g,'');
for (const pin of JSON.parse(read('ios/Aloud.swiftpm/Package.resolved')).pins)
  assert(normalized.includes(pin.identity.replace(/[^a-z0-9]/g,'')), 'Missing resolved-package notice: ' + pin.identity);
console.log('PASS: app / shell cache / native / README versions match v' + version + '; workflow actions use full SHAs; inline/native licenses match and cover resolved packages.');
