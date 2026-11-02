# FollowCheck

See which Instagram accounts don't follow you back, using the data download you get from Meta.

FollowCheck is a static website. **Your file is read only in your browser. It is never uploaded, saved or sent anywhere.** There's no login, no server code, no analytics and no third-party code.

## How it works

1. Request your data from Instagram (Accounts Center → Your information and permissions → Download your information). Choose **Followers and following**, **All time** and **JSON**.
2. Open FollowCheck and choose the .zip, or several .zip files if your download came in parts.
3. FollowCheck reads the archive's table of contents, opens only the followers and following lists, keeps only the usernames, and shows three lists: not following back, mutual followers, and you don't follow back.

## Run it locally

You need Node.js 20 or newer.

```bash
npm install
npm run serve
```

Then open http://localhost:4173/. The local server sends the same headers as production, read from `public/_headers`.

Try it with the invented sample in `sample/sample-instagram-export.zip`.

## Tests

```bash
npm test
```

This runs the engine tests (ZIP reader, file allowlist, parsing, comparison, every error, decompression bombs, a 200,000-follower archive) and a repository check. The check fails if the shipped code uses `innerHTML`, `eval`, browser storage, `XMLHttpRequest`, `sendBeacon` or links to an unexpected site.

```bash
npx playwright install
npm run test:e2e
```

This runs the browser tests in Chromium, Firefox, WebKit, an Android phone and an iPhone. They check the headers, that the page can't reach the network, that importing makes no requests, that nothing is stored, that clearing and `pagehide` remove usernames, offline use, the chart's proportions, layout at 320 to 1280px, dark mode, reduced motion and an axe accessibility scan.

Other scripts:

| Command | What it does |
|---|---|
| `npm run fonts` | Copies the fonts and their licenses from `node_modules` into `public/fonts/` |
| `npm run icons` | Renders the PNG icons and the social image |
| `npm run sample` | Rebuilds the sample download |

## Project layout

```text
public/            The whole website. Deploy this folder as-is.
  index.html       The app
  app.js, app.css  Screens, results and styling
  core/            zip.js (ZIP reader), extract.js (finds and parses lists), analyze.js (comparison)
  sw.js            Service worker for offline use
  _headers         Security headers for Cloudflare Pages
  privacy.html, 404.html, manifest.webmanifest, robots.txt, sitemap.xml, fonts/, icons/
tests/             Engine tests, repository check, browser tests, fixture builders
tools/             Local server, font, icon and sample scripts (development only)
sample/            An invented Instagram download
```

There are no runtime dependencies. `package.json` lists development tools only.

## Deploy to Cloudflare Pages

1. Push this repository to GitHub and make it public, so anyone can inspect the code.
2. In the Cloudflare dashboard, open **Workers & Pages → Create → Pages → Connect to Git** and pick the repository.
3. Set **Framework preset** to *None*, leave **Build command** empty, and set **Build output directory** to `public`.
4. Deploy, then add your custom domain under **Custom domains**.
5. Turn off everything Cloudflare can inject:
   - **Web Analytics**: in the Pages project, under **Metrics**, make sure Web Analytics is not enabled. If the domain's zone has it, turn off automatic setup there too.
   - **Rocket Loader**: zone → **Speed → Optimization → Content Optimization**, set to off.
   - **Email Address Obfuscation**: zone → **Scrape Shield**, set to off.
   - Leave **Zaraz** and any other script injection off.

   The Content-Security-Policy would block injected scripts anyway, but turning them off keeps the console clean.
6. Replace `followcheck.example` with your real domain in `public/index.html`, `public/privacy.html`, `public/robots.txt` and `public/sitemap.xml`.
7. Check the deployed headers:

   ```bash
   curl -sI https://YOUR-DOMAIN/ && curl -sI https://YOUR-DOMAIN/sw.js
   ```

   Every header in `public/_headers` should appear exactly once. `/sw.js` must have `connect-src 'self'`, and every other path must have `connect-src 'none'`.

### Releasing a change

The service worker serves files from its cache first. Whenever you change anything in `public/`, bump `VERSION` in `public/sw.js`. Otherwise, returning visitors keep the old files.

## Privacy design

- **No upload path.** There is no backend, API, database or serverless function. The page's Content-Security-Policy sets `connect-src 'none'`, so the page can't make `fetch`, XHR, WebSocket or beacon requests, even to its own origin. Only the service worker may fetch, and only the site's own files.
- **Reads as little as possible.** `core/zip.js` reads the archive with `File.slice()`. It reads the end record, then the central directory, then only the allowlisted entries: `followers.json`, `followers_N.json`, `following.json` and `following_N.json` in `followers_and_following/`, `connections/` or the archive root. Other filenames are looked at once and dropped. Other entries' bytes are never read, and a test proves it with a recording `Blob`.
- **Safe decompression.** It uses the browser's `DecompressionStream('deflate-raw')`, counts real output bytes against a 256 MB limit, and checks each entry's CRC-32 and size. It rejects encrypted entries.
- **Keeps only usernames.** Timestamps, links and display names are discarded during parsing.
- **Memory only.** Results live in one variable. Clear results, or leaving the page (`pagehide`), empties it and the DOM. Nothing is written to cookies, `localStorage`, `sessionStorage`, IndexedDB, OPFS or the Cache API, and the service worker never sees user data.
- **No third parties.** Fonts and icons are self-hosted. There are no analytics, ads, error reporting or CDNs. Usernames link to Instagram only when tapped, with `rel="noopener noreferrer"` and `Referrer-Policy: no-referrer`.
- **No HTML injection.** Rows are built with `textContent`. There are no inline scripts or styles. The repository check enforces this.

Honest limits, also stated on the privacy page:

- The host sees normal visit logs.
- Other browser extensions may be able to read the page.
- JavaScript can't guarantee memory is forensically erased.
- You have to trust the code the site serves. The public repository and the airplane-mode test let you check.

## Later

Not built yet. Add these only when requested:

- **TikTok support.** TikTok's data download has following and followers lists with usernames, so the comparison works unchanged. The work: detect which app a ZIP came from, add a TikTok list reader with its own allowlist, and switch the wording and profile links per app. TikTok has changed the file's key names over time, and it offers JSON and TXT versions. Build the reader against a real TikTok download (JSON format), not just published examples. Instagram behavior must not change.
- **Facebook: probably not.** Facebook friends are always mutual, so "not following back" applies only to followers and following. Facebook's download lists people by display name, not username, so people with the same name collide, renamed people look like unfollows, and profiles can't be linked. Build it only if results are clearly labeled as approximate.
- CSV export, with a warning that it creates a separate copy of the lists.
- Comparing two downloads to find unfollowers and new followers.
- Native iOS or Android apps.

## Fonts

Bricolage Grotesque and Atkinson Hyperlegible Next are used under the SIL Open Font License 1.1. The license texts are in `public/fonts/`.

## Not affiliated

FollowCheck isn't affiliated with Instagram or Meta.
