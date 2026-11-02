// Writes sample/sample-instagram-export.zip: an invented download for trying
// the site. 180 following, 200 followers, 120 of them mutual.
// Run with: npm run sample

import { mkdirSync, writeFileSync } from 'node:fs';
import { buildExport, names } from '../tests/fixtures.mjs';

const mutual = names(120, 'm');
const followers = [...mutual, ...names(80, 'fan')];
const following = [...mutual, ...names(60, 'idol')];

const out = new URL('../sample/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('sample-instagram-export.zip', out), buildExport({ followers, following, wrapper: 'instagram-sample-2026-01-01' }).buffer);
console.log('Wrote sample/sample-instagram-export.zip');
