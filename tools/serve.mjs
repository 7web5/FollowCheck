// Local static server that behaves like Cloudflare Pages for this site:
// it applies public/_headers with the same rules (all matching rules in order,
// "! Name" detaches, repeated names are joined with a comma), uses pretty URLs
// and serves 404.html with a 404 status.
//
// Usage: node tools/serve.mjs [port]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../public/', import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
};

/** Parses a Cloudflare Pages _headers file into [{ pattern, set: [[name, value]], unset: [name] }]. */
export function parseHeaders(text) {
  const rules = [];
  let rule = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      rule = { pattern: raw.trim(), set: [], unset: [] };
      rules.push(rule);
      continue;
    }
    if (!rule) throw new Error(`Header without a URL rule: ${raw}`);
    const line = raw.trim();
    if (line.startsWith('!')) {
      rule.unset.push(line.slice(1).trim().toLowerCase());
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error(`Invalid header line: ${raw}`);
    rule.set.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return rules;
}

function patternToRegExp(pattern) {
  const path = pattern.replace(/^https?:\/\/[^/]+/, '');
  const source = path
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z]\w*/g, '[^/]+'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

/** Applies matching rules in order, the way Pages does. */
export function headersFor(rules, pathname) {
  const headers = new Map();
  const fromFile = new Set();
  for (const rule of rules) {
    if (!patternToRegExp(rule.pattern).test(pathname)) continue;
    for (const name of rule.unset) headers.delete(name);
    for (const [name, value] of rule.set) {
      const key = name.toLowerCase();
      if (fromFile.has(key) && headers.has(key)) headers.set(key, [headers.get(key)[0], `${headers.get(key)[1]}, ${value}`]);
      else headers.set(key, [name, value]);
      fromFile.add(key);
    }
  }
  return Object.fromEntries([...headers.values()]);
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function resolve(pathname) {
  if (pathname.endsWith('/index.html')) return { redirect: pathname.slice(0, -'index.html'.length) };
  if (pathname.endsWith('.html')) return { redirect: pathname.slice(0, -'.html'.length) };
  const local = normalize(join(ROOT, decodeURIComponent(pathname)));
  if (!local.startsWith(ROOT) && `${local}${sep}` !== ROOT) return null;
  if (pathname.endsWith('/')) return (await isFile(join(local, 'index.html'))) ? join(local, 'index.html') : null;
  if (pathname.split('/').pop().startsWith('_')) return null;
  if (await isFile(local)) return local;
  if (await isFile(`${local}.html`)) return `${local}.html`;
  return null;
}

export async function startServer(port = 4173) {
  const rules = parseHeaders(await readFile(join(ROOT, '_headers'), 'utf8'));
  const server = createServer(async (request, response) => {
    try {
      const { pathname } = new URL(request.url, 'http://localhost');
      const headers = headersFor(rules, pathname);
      const found = await resolve(pathname);
      if (found?.redirect) {
        response.writeHead(308, { ...headers, Location: found.redirect });
        return response.end();
      }
      const file = found ?? join(ROOT, '404.html');
      const body = await readFile(file);
      response.writeHead(found ? 200 : 404, {
        ...headers,
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        'Content-Length': body.length,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((done) => server.listen(port, '127.0.0.1', done));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 4173);
  await startServer(port);
  console.log(`FollowCheck running at http://localhost:${port}/`);
}
