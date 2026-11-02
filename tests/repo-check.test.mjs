// Fails if the shipped site contains anything the privacy design forbids.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const CHECKED = new Set(['.html', '.js', '.css', '.webmanifest', '.xml', '.svg']);
const CHECKED_NAMES = new Set(['_headers', 'robots.txt']);

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return CHECKED.has(extname(entry.name)) || CHECKED_NAMES.has(basename(path)) ? [path] : [];
  });
}

const sources = files(PUBLIC).map((path) => ({ path: relative(PUBLIC, path).replace(/\\/g, '/'), text: readFileSync(path, 'utf8') }));

const FORBIDDEN = [
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'document.write',
  'eval(',
  'new Function',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'XMLHttpRequest',
  'sendBeacon',
  'WebSocket',
  'EventSource',
  'document.cookie',
  'console.',
];

// Allowed non-local URLs: the Instagram profile link, the footer's source code
// link, our own domain placeholder, and XML namespaces (never fetched).
const ALLOWED_URLS = [
  /^https:\/\/www\.instagram\.com\/$/,
  /^https:\/\/github\.com\/7web5\/FollowCheck$/,
  /^https:\/\/followcheck\.example\//,
  /^http:\/\/www\.w3\.org\/2000\/svg$/,
  /^http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9$/,
  /^https:\/\/developers\.cloudflare\.com\/pages\/configuration\/headers\/$/,
];

test('shipped code uses no forbidden APIs', () => {
  assert.ok(sources.length > 10);
  for (const { path, text } of sources) {
    for (const word of FORBIDDEN) {
      assert.ok(!text.includes(word), `${path} contains ${word}`);
    }
  }
});

test('shipped code links to no other sites', () => {
  for (const { path, text } of sources) {
    for (const [url] of text.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'`)<>]*/gi)) {
      if (/^\/\/(localhost|127\.0\.0\.1)/.test(url)) continue;
      assert.ok(ALLOWED_URLS.some((pattern) => pattern.test(url)), `${path} links to ${url}`);
    }
  }
});

test('pages have no inline scripts, inline styles or style attributes', () => {
  for (const { path, text } of sources.filter((s) => s.path.endsWith('.html'))) {
    assert.doesNotMatch(text, /<script(?![^>]*\bsrc=)[^>]*>/i, `${path} has an inline script`);
    assert.doesNotMatch(text, /<style/i, `${path} has a style element`);
    assert.doesNotMatch(text, /\sstyle=/i, `${path} has a style attribute`);
    assert.doesNotMatch(text, /\son[a-z]+=/i, `${path} has an inline event handler`);
  }
  for (const { path, text } of sources.filter((s) => s.path.endsWith('.js'))) {
    assert.doesNotMatch(text, /setAttribute\(\s*['"](style|on[a-z]+)/i, `${path} sets an inline style or handler`);
  }
});

test('the service worker precaches every file it needs and only site files', () => {
  const sw = sources.find((s) => s.path === 'sw.js').text;
  const cached = [...sw.matchAll(/^\s+'(\/[^']*)',$/gm)].map((m) => m[1]);
  for (const path of cached.filter((p) => p !== '/' && p !== '/privacy')) {
    assert.ok(existsSync(join(PUBLIC, path)), `${path} does not exist`);
  }
  for (const module of ['/app.js', '/core/zip.js', '/core/extract.js', '/core/analyze.js', '/app.css']) {
    assert.ok(cached.includes(module), `${module} is not precached`);
  }
});

test('the search field has autocomplete off', () => {
  const html = sources.find((s) => s.path === 'index.html').text;
  assert.match(html, /<input id="search-input"[^>]*autocomplete="off"/);
});
