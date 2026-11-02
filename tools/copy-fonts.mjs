// Copies the self-hosted fonts and their licenses from node_modules into public/fonts.
// Run with: npm run fonts

import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const out = new URL('public/fonts/', root);
mkdirSync(out, { recursive: true });

for (const family of ['bricolage-grotesque', 'atkinson-hyperlegible-next']) {
  const pkg = new URL(`node_modules/@fontsource-variable/${family}/`, root);
  for (const subset of ['latin', 'latin-ext']) {
    const file = `${family}-${subset}-wght-normal.woff2`;
    copyFileSync(new URL(`files/${file}`, pkg), new URL(file, out));
  }
  copyFileSync(new URL('LICENSE', pkg), new URL(`${family}-OFL.txt`, out));
}
console.log(`Fonts copied to ${fileURLToPath(out)}`);
