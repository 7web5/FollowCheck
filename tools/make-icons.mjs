// Renders the PNG icons and the social image from SVG with Playwright.
// Run with: npm run icons

import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = new URL('../public/icons/', import.meta.url);

const VIOLET = '#6a2cf0';
const ORANGE = '#ff8a1f';
const PINK = '#c81e63';
const PAPER = '#fbf7f5';
const INK = '#1d1238';

// Two overlapping circles centred in a size x size box, scaled by `fill`.
function mark(size, fill, background) {
  const r = (size * fill) / 3.2;
  const cy = size / 2;
  const left = size / 2 - r * 0.4;
  const right = size / 2 + r * 0.4;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : ''}
    <defs><clipPath id="l"><circle cx="${left}" cy="${cy}" r="${r}"/></clipPath></defs>
    <circle cx="${left}" cy="${cy}" r="${r}" fill="${VIOLET}"/>
    <circle cx="${right}" cy="${cy}" r="${r}" fill="${ORANGE}"/>
    <circle cx="${right}" cy="${cy}" r="${r}" fill="${PINK}" clip-path="url(#l)"/>
  </svg>`;
}

const social = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${PAPER}"/>
  <rect x="0" y="390" width="330" height="240" fill="${VIOLET}"/>
  <rect x="330" y="390" width="540" height="240" fill="${PINK}"/>
  <rect x="870" y="390" width="330" height="240" fill="${ORANGE}"/>
  <text x="80" y="200" font-family="Bricolage Grotesque, sans-serif" font-weight="800" font-size="96" letter-spacing="-2" fill="${INK}">See who follows</text>
  <text x="80" y="300" font-family="Bricolage Grotesque, sans-serif" font-weight="800" font-size="96" letter-spacing="-2" fill="${INK}">you back.</text>
  <text x="600" y="525" text-anchor="middle" font-family="Bricolage Grotesque, sans-serif" font-weight="800" font-size="64" fill="#ffffff">FollowCheck</text>
</svg>`;

const fontCss = `@font-face { font-family: "Bricolage Grotesque"; font-weight: 200 800;
  src: url("http://fonts.invalid/bricolage.woff2") format("woff2"); }`;

const targets = [
  ['icon-192.png', mark(192, 1, PAPER), 192, 192],
  ['icon-512.png', mark(512, 1, PAPER), 512, 512],
  // Maskable icons keep the mark inside the central 80% safe zone.
  ['icon-maskable-512.png', mark(512, 0.72, PAPER), 512, 512],
  ['apple-touch-icon.png', mark(180, 0.9, PAPER), 180, 180],
  ['favicon-32.png', mark(32, 1.05), 32, 32],
  ['og-image.png', social, 1200, 630],
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.route('http://fonts.invalid/bricolage.woff2', (route) =>
  route.fulfill({ path: fileURLToPath(new URL('../public/fonts/bricolage-grotesque-latin-wght-normal.woff2', import.meta.url)) }),
);
for (const [file, svg, width, height] of targets) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<style>${fontCss} html,body{margin:0;background:transparent}</style>${svg}`);
  await page.evaluate(() => document.fonts.ready);
  writeFileSync(new URL(file, out), await page.screenshot({ omitBackground: true }));
}
await browser.close();
console.log('Icons written to public/icons/');
