// Browser tests. They run against tools/serve.mjs, which sends the real
// headers from public/_headers, on Chromium, Firefox, WebKit and phones.

import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { buildExport, names } from './fixtures.mjs';
import { makeZip } from './zipwriter.mjs';

/* Fixtures */

const mutual = names(120, 'm');
const fans = names(80, 'fan');
const idols = [...names(59, 'idol'), 'a_very_long_username_of_thirty'];
const sample = buildExport({ followers: [...mutual, ...fans], following: [...mutual, ...idols] });
const everyone = [...mutual, ...fans, ...idols];

const big = buildExport({ followers: names(10, 'x'), following: names(700, 'nfb') });

const CSP_PAGE = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SECURITY_HEADERS = {
  'content-security-policy': CSP_PAGE,
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
};

const SW_SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const PRECACHED = [...SW_SOURCE.matchAll(/^\s+'(\/[^']*)',$/gm)].map((m) => m[1]);

const test = base.extend({
  // Every test fails on a console error unless it says it expects some.
  consoleErrors: [
    async ({ page }, use, testInfo) => {
      const errors = [];
      page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
      page.on('pageerror', (error) => errors.push(String(error)));
      await use(errors);
      if (!testInfo.annotations.some((a) => a.type === 'expects-console-errors')) expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});

const desktopOnly = (testInfo) => test.skip(testInfo.project.name !== 'chromium', 'Runs once; not engine-specific.');

async function importZips(page, zips) {
  await page.locator('#file-input').setInputFiles(
    zips.map((zip, i) => ({ name: `instagram-part-${i + 1}.zip`, mimeType: 'application/zip', buffer: Buffer.isBuffer(zip) ? zip : zip.buffer })),
  );
}

async function dismissPopup(page) {
  await expect(page.locator('#celebrate')).toBeVisible();
  await page.locator('#celebrate-ok').click();
  await expect(page.locator('#celebrate')).toBeHidden();
}

async function openResults(page, zips = [sample]) {
  await page.goto('/');
  await importZips(page, zips);
  await expect(page.locator('#results-heading')).toBeVisible();
  await dismissPopup(page);
}

const listNames = (page) => page.locator('#list a').allTextContents();

async function pageHasNoUsernames(page) {
  const html = await page.content();
  for (const name of everyone) expect(html.includes(name), name).toBe(false);
}

async function swReady(page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
}

/* Headers */

test.describe('headers', () => {
  test('every page and file sends the security headers', async ({ request }, testInfo) => {
    desktopOnly(testInfo);
    for (const path of ['/', '/privacy', '/app.js', '/app.css', '/core/zip.js', '/manifest.webmanifest', '/icons/icon-192.png', '/fonts/bricolage-grotesque-latin-wght-normal.woff2', '/does-not-exist']) {
      const response = await request.get(path);
      const headers = response.headers();
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(headers[name], `${path} ${name}`).toBe(value);
    }
    expect((await request.get('/does-not-exist')).status()).toBe(404);
  });

  test('only /sw.js may connect to its own origin', async ({ request }, testInfo) => {
    desktopOnly(testInfo);
    const headers = (await request.get('/sw.js')).headers();
    expect(headers['content-security-policy']).toBe(CSP_PAGE.replace("connect-src 'none'", "connect-src 'self'"));
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (name !== 'content-security-policy') expect(headers[name]).toBe(value);
    }
  });
});

/* Privacy */

test.describe('privacy', () => {
  test('the page cannot reach the network', async ({ page }, testInfo) => {
    testInfo.annotations.push({ type: 'expects-console-errors' });
    const reached = [];
    await page.context().route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(new URL(page.url() === 'about:blank' ? testInfo.project.use.baseURL : page.url()).origin)) return route.continue();
      reached.push(url);
      return route.abort();
    });
    await page.goto('/');
    const result = await page.evaluate(async () => {
      const violations = [];
      document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective || e.violatedDirective));
      const out = {};
      const attempt = async (fn) => {
        try {
          await fn();
          return 'allowed';
        } catch {
          return 'blocked';
        }
      };
      out.fetch = await attempt(() => fetch('https://example.com/'));
      out.fetchSelf = await attempt(() => fetch('/app.js'));
      out.webSocket = await new Promise((resolve) => {
        try {
          const ws = new WebSocket('wss://example.com/');
          ws.onopen = () => resolve('allowed');
          ws.onerror = () => resolve('blocked');
          ws.onclose = () => resolve('blocked');
        } catch {
          resolve('blocked');
        }
      });
      try {
        navigator.sendBeacon('https://example.com/beacon', 'x');
      } catch {
        // Blocked outright.
      }
      out.image = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve('allowed');
        img.onerror = () => resolve('blocked');
        img.src = 'https://example.com/pixel.png';
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      out.violations = violations;
      return out;
    });
    expect(result.fetch).toBe('blocked');
    expect(result.fetchSelf).toBe('blocked');
    expect(result.webSocket).toBe('blocked');
    expect(result.image).toBe('blocked');
    expect(result.violations).toContain('connect-src');
    expect(result.violations).toContain('img-src');
    expect(reached).toEqual([]);
  });

  test('importing a file makes no network requests', async ({ page }) => {
    await page.goto('/');
    await swReady(page);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const requests = [];
    page.context().on('request', (request) => requests.push(request.url()));
    await importZips(page, [sample]);
    await expect(page.locator('#results-heading')).toBeVisible();
    await dismissPopup(page);
    await page.locator('#tab-mutual').click();
    await page.locator('#search-input').fill('river');
    await page.waitForTimeout(300);
    expect(requests).toEqual([]);
  });

  test('no storage is used beyond the cached site files', async ({ page, context }) => {
    await openResults(page);
    await swReady(page);
    await page.locator('#clear').click();
    const storage = await page.evaluate(async () => {
      const out = { local: localStorage.length, session: sessionStorage.length, cookie: document.cookie, caches: {} };
      out.idb = indexedDB.databases ? (await indexedDB.databases()).map((db) => db.name) : [];
      for (const key of await caches.keys()) {
        const cache = await caches.open(key);
        out.caches[key] = (await cache.keys()).map((request) => new URL(request.url).pathname);
      }
      try {
        const root = await navigator.storage.getDirectory();
        out.opfs = [];
        for await (const [name] of root.entries()) out.opfs.push(name);
      } catch {
        out.opfs = [];
      }
      return out;
    });
    expect(storage.local).toBe(0);
    expect(storage.session).toBe(0);
    expect(storage.cookie).toBe('');
    expect(await context.cookies()).toEqual([]);
    expect(storage.idb).toEqual([]);
    expect(storage.opfs).toEqual([]);
    expect(Object.keys(storage.caches)).toEqual([expect.stringMatching(/^followcheck-v\d+$/)]);
    expect(Object.values(storage.caches)[0].sort()).toEqual([...PRECACHED].sort());
  });

  test('Clear results removes every username from the page', async ({ page }) => {
    await openResults(page);
    expect(await listNames(page)).toContain(idols[0]);
    await page.locator('#search-input').fill('mriver');
    await page.locator('#clear').click();
    await expect(page.locator('#start-screen')).toBeVisible();
    await expect(page.locator('#choose')).toBeFocused();
    await expect(page.locator('#search-input')).toHaveValue('');
    expect(await page.locator('#file-input').evaluate((input) => input.files.length)).toBe(0);
    await pageHasNoUsernames(page);
  });

  test('pagehide clears the results, but hiding the tab does not', async ({ page, context }) => {
    await openResults(page);
    const other = await context.newPage();
    await other.goto('/privacy');
    await page.bringToFront();
    await expect(page.locator('#results-screen')).toBeVisible();
    await other.close();

    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect(page.locator('#start-screen')).toBeVisible();
    await pageHasNoUsernames(page);
  });

  test('leaving and coming back shows no results', async ({ page }) => {
    await openResults(page);
    await page.getByRole('link', { name: 'Privacy' }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await page.goBack();
    await expect(page.locator('#start-screen')).toBeVisible();
    await pageHasNoUsernames(page);
  });

  test('works offline after the first visit', async ({ page, context }) => {
    await page.goto('/');
    await swReady(page);
    await page.reload();
    expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await context.setOffline(true);
    await page.reload();
    await importZips(page, [sample]);
    await expect(page.locator('#results-heading')).toBeVisible();
    await expect(page.locator('#tab-notFollowingBack [data-count]')).toHaveText('60');
    await context.setOffline(false);
  });
});

/* Behavior */

test.describe('import', () => {
  test('shows the three lists with counts', async ({ page }) => {
    await openResults(page);
    await expect(page.locator('#results-heading')).toBeFocused();
    await expect(page.locator('#tab-notFollowingBack [data-count]')).toHaveText('60');
    await expect(page.locator('#tab-mutual [data-count]')).toHaveText('120');
    await expect(page.locator('#tab-notFollowedBack [data-count]')).toHaveText('80');
    await expect(page.locator('#tab-notFollowingBack')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#list-description')).toHaveText("You follow these accounts, but they don't follow you.");
    expect(await listNames(page)).toEqual([...idols].sort());
    await expect(page.locator('#warnings li')).toHaveCount(0);

    const link = page.locator('#list a').first();
    await expect(link).toHaveAttribute('href', `https://www.instagram.com/${[...idols].sort()[0]}/`);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('reads a download split across several ZIPs and warns about a missing part', async ({ page }) => {
    const followers = names(60);
    const one = makeZip([{ name: 'connections/followers_and_following/followers_1.json', data: JSON.stringify(followers.slice(0, 20).map((n) => ({ string_list_data: [{ value: n }] }))) }]);
    const renamed = makeZip([
      { name: 'connections/followers_and_following/followers_3.json', data: JSON.stringify(followers.slice(40).map((n) => ({ string_list_data: [{ value: n }] }))) },
      { name: 'connections/followers_and_following/following.json', data: JSON.stringify({ relationships_following: [{ string_list_data: [{ value: 'ana' }] }] }) },
    ]);
    await openResults(page, [one, renamed]);
    await expect(page.locator('#tab-notFollowedBack [data-count]')).toHaveText('40');
    await expect(page.locator('#warnings li')).toHaveText([
      'Part 2 of your followers list is missing, so these results are incomplete. If your download came in several parts, select all of them together.',
    ]);
  });

  test('reports skipped entries', async ({ page }) => {
    const zip = makeZip([
      { name: 'followers_and_following/followers_1.json', data: JSON.stringify([{ string_list_data: [{ value: 'ana' }] }, {}, { title: 'Not A Name' }]) },
      { name: 'followers_and_following/following.json', data: JSON.stringify({ relationships_following: [{ title: 'ana' }] }) },
    ]);
    await openResults(page, [zip]);
    await expect(page.locator('#warnings li')).toHaveText([
      '2 entries in your followers list had no readable username and were left out. Because of this, some accounts may wrongly show as not following back.',
    ]);
  });

  test('warns when the followers list only covers a short date range', async ({ page }) => {
    const recent = Math.floor(Date.now() / 1000) - 60 * 24 * 60 * 60;
    const zip = makeZip([
      { name: 'connections/followers_and_following/followers_1.json', data: JSON.stringify([{ string_list_data: [{ value: 'ana', timestamp: recent }] }]) },
      { name: 'connections/followers_and_following/following.json', data: JSON.stringify({ relationships_following: [{ title: 'ana' }, { title: 'bea' }] }) },
    ]);
    await openResults(page, [zip]);
    await expect(page.locator('#warnings li')).toHaveCount(1);
    await expect(page.locator('#warnings li')).toContainText('Your followers list only goes back to');
    await expect(page.locator('#warnings li')).toContainText('may wrongly show as not following back');
  });

  const errorCases = [
    ['not a ZIP', [Buffer.from('hello')], "This file isn't a ZIP archive. Choose the .zip file you downloaded from Instagram, without unzipping it."],
    ['an HTML export', [makeZip([{ name: 'connections/followers_and_following/followers_1.html', data: '<p>' }])], 'This download is in HTML format. Request a new download from Instagram and choose JSON as the format.'],
    ['two downloads', [sample, sample], 'These files repeat the same list, so they may be two separate downloads. Select one download, or all the parts of a single download.'],
    ['a missing followers list', [makeZip([{ name: 'connections/followers_and_following/following.json', data: '{"relationships_following":[]}' }])], 'Your followers list is missing from this archive. If your download came in several parts, select all of them together.'],
  ];
  for (const [label, zips, message] of errorCases) {
    test(`explains ${label}`, async ({ page }) => {
      await page.goto('/');
      await importZips(page, zips);
      await expect(page.getByRole('alert')).toHaveText(message);
      await expect(page.locator('#start-screen')).toBeVisible();
      await expect(page.locator('#choose')).toBeFocused();
    });
  }

  test('the whole page accepts a dropped file and never navigates to it', async ({ page }) => {
    await page.goto('/');
    const url = page.url();
    const prevented = await page.evaluate(async (bytes) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], 'instagram.zip', { type: 'application/zip' }));
      const target = document.querySelector('.footnote') ?? document.body;
      target.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }));
      const dragging = document.getElementById('plate').classList.contains('is-dragging');
      const drop = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true });
      document.querySelector('.steps').dispatchEvent(drop);
      return { dragging, prevented: drop.defaultPrevented };
    }, [...sample.buffer]);
    expect(prevented).toEqual({ dragging: true, prevented: true });
    await expect(page.locator('#results-heading')).toBeVisible();
    expect(page.url()).toBe(url);
    await expect(page.locator('#plate')).not.toHaveClass(/is-dragging/);
  });

  test('explains when the browser is too old', async ({ page }) => {
    await page.addInitScript(() => {
      window.DecompressionStream = class {
        constructor() {
          throw new TypeError('unsupported');
        }
      };
    });
    await page.goto('/');
    await expect(page.getByRole('alert')).toHaveText(
      'This browser is too old to read your file. Update it, or open this page in a current version of Chrome, Safari, Firefox or Edge.',
    );
    await expect(page.locator('#choose')).toBeHidden();
  });

  test('the drop hint shows only with a mouse', async ({ page, isMobile }) => {
    await page.goto('/');
    if (isMobile) await expect(page.locator('.drop-hint')).toBeHidden();
    else await expect(page.locator('.drop-hint')).toBeVisible();
  });
});

test.describe('results', () => {
  test('a popup celebrates the results, then focus moves to them', async ({ page }) => {
    await page.goto('/');
    await importZips(page, [sample]);
    const popup = page.getByRole('dialog', { name: "60 accounts don't follow you back" });
    await expect(popup).toBeVisible();
    await expect(page.locator('#celebrate-detail')).toHaveText("120 mutual followers · 80 you don't follow back");
    await expect(page.locator('#celebrate-ok')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();
    await expect(page.locator('#results-heading')).toBeFocused();
  });

  test('the popup cheers when everyone follows back, and clearing closes it', async ({ page }) => {
    await page.goto('/');
    await importZips(page, [buildExport({ followers: ['ana', 'bea'], following: ['ana'] })]);
    await expect(page.locator('#celebrate-title')).toHaveText('Everyone you follow follows you back!');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await expect(page.locator('#celebrate')).toBeHidden();
    await expect(page.locator('#celebrate-title')).toHaveText('');
  });

  test('tabs follow the arrow keys', async ({ page }) => {
    await openResults(page);
    await page.locator('#tab-notFollowingBack').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#tab-mutual')).toBeFocused();
    await expect(page.locator('#tab-mutual')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#tab-notFollowingBack')).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator('#panel')).toHaveAttribute('aria-labelledby', 'tab-mutual');
    expect(await listNames(page)).toEqual([...mutual].sort());
    await page.keyboard.press('End');
    await expect(page.locator('#tab-notFollowedBack')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#tab-notFollowingBack')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#tab-notFollowedBack')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#list-description')).toHaveText("These accounts follow you, but you don't follow them.");
  });

  test('search filters, ignores case and @, and points to other lists', async ({ page }) => {
    await openResults(page);
    const search = page.locator('#search-input');
    await expect(search).toHaveAttribute('autocomplete', 'off');
    await search.fill('@IDOLRIVER.');
    expect(await listNames(page)).toEqual(idols.filter((n) => n.startsWith('idolriver.')).sort());
    await search.fill('fanmaple');
    await expect(page.locator('#list a')).toHaveCount(0);
    await expect(page.locator('#list-note')).toHaveText("No match in this list. Found in You don't follow back.");
    await search.fill('zzz');
    await expect(page.locator('#list-note')).toHaveText('No match in any list.');
    await page.locator('#tab-notFollowedBack').click();
    await search.fill('fanmaple');
    expect((await listNames(page)).length).toBeGreaterThan(0);
  });

  test('long lists render 300 rows at a time', async ({ page }) => {
    await openResults(page, [big]);
    await expect(page.locator('#list a')).toHaveCount(300);
    await page.locator('#more').click();
    await expect(page.locator('#list a')).toHaveCount(600);
    await expect(page.locator('#more')).toHaveText('Show 100 more');
    await page.locator('#more').click();
    await expect(page.locator('#list a')).toHaveCount(700);
    await expect(page.locator('#more')).toBeHidden();
  });

  test('rows are tall enough to tap', async ({ page }) => {
    await openResults(page);
    const heights = await page.locator('#list a').evaluateAll((links) => links.slice(0, 20).map((a) => a.getBoundingClientRect().height));
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
  });

  test('the search box stays visible while scrolling', async ({ page }) => {
    await openResults(page, [big]);
    await page.locator('#list a').nth(250).scrollIntoViewIfNeeded();
    const box = await page.locator('#search-input').boundingBox();
    const viewport = page.viewportSize();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  });

  test('the chart is drawn to scale', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openResults(page);
    const rects = await page.evaluate(() => {
      const rect = (selector) => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      };
      return {
        blue: rect('.chart-segment-following'),
        green: rect('.chart-segment-mutual'),
        gold: rect('.chart-segment-followers'),
        following: rect('.chart-line-following'),
        followers: rect('.chart-line-followers'),
      };
    });
    const total = rects.blue.width + rects.green.width + rects.gold.width;
    expect(rects.blue.width / total).toBeCloseTo(60 / 260, 2);
    expect(rects.green.width / total).toBeCloseTo(120 / 260, 2);
    expect(rects.gold.width / total).toBeCloseTo(80 / 260, 2);
    expect(Math.abs(rects.following.left - rects.blue.left)).toBeLessThan(1);
    expect(Math.abs(rects.following.right - rects.green.right)).toBeLessThan(1);
    expect(Math.abs(rects.followers.left - rects.green.left)).toBeLessThan(1);
    expect(Math.abs(rects.followers.right - rects.gold.right)).toBeLessThan(1);
    await expect(page.locator('#chart-following')).toHaveText('180 following');
    await expect(page.locator('#chart-followers')).toHaveText('200 followers');
    await expect(page.locator('.chart-graphic')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#chart-text')).toContainText('You follow 180 accounts and 200 accounts follow you.');
  });

  test('the chart settles from equal thirds to scale', async ({ page }) => {
    await openResults(page);
    await expect.poll(() => page.locator('.chart-segment-following').evaluate((el) => el.getBoundingClientRect().width / el.parentElement.getBoundingClientRect().width)).toBeCloseTo(60 / 260, 2);
  });
});

/* Layout, theme and accessibility */

test.describe('layout', () => {
  for (const width of [320, 390, 768, 1280]) {
    test(`no horizontal scroll at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/');
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(await overflow()).toBeLessThanOrEqual(0);
      await importZips(page, [sample]);
      await expect(page.locator('#results-heading')).toBeVisible();
      expect(await overflow()).toBeLessThanOrEqual(0);
      await page.goto('/privacy');
      expect(await overflow()).toBeLessThanOrEqual(0);
    });
  }

  test('dark mode uses the dark palette', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(18, 13, 31)');
    await page.emulateMedia({ colorScheme: 'light' });
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(251, 247, 245)');
  });

  test('reduced motion turns off every animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const motion = await page.evaluate(() => ({
      chart: getComputedStyle(document.getElementById('chart-grid')).transitionDuration,
      band: getComputedStyle(document.querySelector('.band-following')).animationName,
      marquee: getComputedStyle(document.querySelector('.marquee-track')).animationName,
      spark: getComputedStyle(document.querySelector('.art-spark')).animationName,
    }));
    expect(motion).toEqual({ chart: '0s', band: 'none', marquee: 'none', spark: 'none' });
    await expect(page.locator('#marquee-toggle')).toBeHidden();
  });

  test('the moving words scroll and can be paused', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    const offset = () => page.locator('.marquee-track').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
    const first = await offset();
    await expect.poll(offset).not.toBe(first);

    const toggle = page.locator('#marquee-toggle');
    await toggle.click();
    await expect(toggle).toHaveText('Play');
    await expect(toggle).toHaveAttribute('aria-label', 'Play moving words');
    const paused = await offset();
    await page.waitForTimeout(400);
    expect(await offset()).toBe(paused);
    await toggle.click();
    await expect(toggle).toHaveAccessibleName('Pause moving words');
    await expect(page.locator('.marquee-viewport')).toHaveAttribute('aria-hidden', 'true');
  });

  test('skip link moves to the main content', async ({ page, isMobile }, testInfo) => {
    test.skip(isMobile || testInfo.project.name === 'webkit', 'Tab key navigation to links depends on platform settings.');
    await page.goto('/');
    await page.keyboard.press('Tab');
    await expect(page.locator('.skip-link')).toBeFocused();
    await expect(page.locator('.skip-link')).toBeInViewport();
  });
});

test.describe('accessibility', () => {
  const scan = async (page) => {
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    return violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  };

  for (const scheme of ['light', 'dark']) {
    test(`no serious issues in ${scheme} mode`, async ({ page }, testInfo) => {
      // The 404 page logs a failed load by design. Axe is slow in WebKit.
      testInfo.annotations.push({ type: 'expects-console-errors' });
      test.setTimeout(120_000);
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.goto('/');
      expect(await scan(page)).toEqual([]);
      await importZips(page, [sample]);
      await expect(page.locator('#celebrate')).toBeVisible();
      expect(await scan(page)).toEqual([]);
      await dismissPopup(page);
      expect(await scan(page)).toEqual([]);
      await page.locator('#search-input').fill('zzz');
      expect(await scan(page)).toEqual([]);
      await page.goto('/privacy');
      expect(await scan(page)).toEqual([]);
      await page.goto('/does-not-exist');
      expect(await scan(page)).toEqual([]);
    });
  }
});
