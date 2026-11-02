import { extractLists, ImportError } from './core/extract.js';
import { compare, chartColumns } from './core/analyze.js';

const PAGE_SIZE = 300;
const PROFILE_URL = 'https://www.instagram.com/';

const LISTS = [
  {
    key: 'notFollowingBack',
    name: 'Not following back',
    description: "You follow these accounts, but they don't follow you.",
  },
  {
    key: 'mutual',
    name: 'Mutual followers',
    description: 'You and these accounts follow each other.',
  },
  {
    key: 'notFollowedBack',
    name: "You don't follow back",
    description: "These accounts follow you, but you don't follow them.",
  },
];

const STATUS = {
  finding: 'Finding your lists…',
  followers: 'Reading your followers…',
  following: 'Reading who you follow…',
  comparing: 'Comparing your lists…',
};

const ERRORS = {
  NOT_ZIP: "This file isn't a ZIP archive. Choose the .zip file you downloaded from Instagram, without unzipping it.",
  HTML_EXPORT: 'This download is in HTML format. Request a new download from Instagram and choose JSON as the format.',
  NO_LISTS: 'This archive has no followers or following lists. Request a new download from Instagram and include "Followers and following".',
  FOLLOWERS_MISSING: 'Your followers list is missing from this archive. If your download came in several parts, select all of them together.',
  FOLLOWING_MISSING: 'Your following list is missing from this archive. If your download came in several parts, select all of them together.',
  ENCRYPTED: 'This archive is password protected. Choose the original .zip file from Instagram.',
  DAMAGED: 'This archive is damaged or incomplete. Download it from Instagram again, then try once more.',
  TOO_LARGE: 'A follower list in this archive is too large to open safely.',
  MIXED_DOWNLOADS: 'These files repeat the same list, so they may be two separate downloads. Select one download, or all the parts of a single download.',
};

const UNSUPPORTED =
  'This browser is too old to read your file. Update it, or open this page in a current version of Chrome, Safari, Firefox or Edge.';

const $ = (id) => document.getElementById(id);
const ui = {
  screens: { start: $('start-screen'), busy: $('busy-screen'), results: $('results-screen') },
  plate: $('plate'),
  choose: $('choose'),
  fileInput: $('file-input'),
  error: $('error'),
  status: $('status'),
  resultsHeading: $('results-heading'),
  clear: $('clear'),
  warnings: $('warnings'),
  chart: $('chart'),
  chartGrid: $('chart-grid'),
  chartFollowing: $('chart-following'),
  chartFollowers: $('chart-followers'),
  chartText: $('chart-text'),
  tabs: LISTS.map((list) => $(`tab-${list.key}`)),
  panel: $('panel'),
  description: $('list-description'),
  search: $('search-input'),
  note: $('list-note'),
  list: $('list'),
  more: $('more'),
  marquee: $('marquee'),
  marqueeToggle: $('marquee-toggle'),
  celebrate: $('celebrate'),
  celebrateTitle: $('celebrate-title'),
  celebrateDetail: $('celebrate-detail'),
  celebrateOk: $('celebrate-ok'),
};

const number = new Intl.NumberFormat('en');
const count = (n, one, many) => `${number.format(n)} ${n === 1 ? one : many}`;

// The only place results are kept. Clearing sets it back to null.
let results = null;
// Bumped on every clear, so an import that finishes afterwards is dropped.
let generation = 0;
let busy = false;

function showScreen(name) {
  for (const [key, screen] of Object.entries(ui.screens)) screen.hidden = key !== name;
}

function setError(message) {
  ui.error.textContent = message;
}

function messageFor(error) {
  if (error instanceof ImportError) {
    if (error.code === 'UNKNOWN_FORMAT') {
      return `FollowCheck doesn't recognize the format of your ${error.list === 'following' ? 'following' : 'followers'} list. Instagram may have changed it.`;
    }
    if (ERRORS[error.code]) return ERRORS[error.code];
  }
  return ERRORS.DAMAGED;
}

function warningText(warning) {
  const list = warning.list === 'following' ? 'following list' : 'followers list';
  if (warning.type === 'missing-parts') {
    const parts = warning.parts.map((n) => number.format(n));
    const which = parts.length === 1 ? `Part ${parts[0]}` : `Parts ${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
    return `${which} of your ${list} ${parts.length === 1 ? 'is' : 'are'} missing, so these results are incomplete. If your download came in several parts, select all of them together.`;
  }
  return warning.count === 1
    ? `1 entry in your ${list} had no readable username and was left out.`
    : `${number.format(warning.count)} entries in your ${list} had no readable username and were left out.`;
}

function supportsDeflateRaw() {
  try {
    new DecompressionStream('deflate-raw');
    return true;
  } catch {
    return false;
  }
}

/* Import */

async function importFiles(fileList) {
  const files = [...(fileList ?? [])];
  if (!files.length || busy) return;
  busy = true;
  clearResults();
  const mine = generation;
  setError('');
  ui.status.textContent = STATUS.finding;
  showScreen('busy');

  try {
    const lists = await extractLists(files, {
      onProgress: (step) => {
        if (mine === generation) ui.status.textContent = STATUS[step];
      },
    });
    if (mine !== generation) return;
    ui.status.textContent = STATUS.comparing;
    const compared = compare(lists.followers, lists.following);
    results = { ...compared, warnings: lists.warnings, active: 0, matches: [], shown: 0 };
    showResults();
  } catch (error) {
    if (mine !== generation) return;
    showScreen('start');
    setError(messageFor(error));
    ui.choose.focus();
  } finally {
    busy = false;
    ui.fileInput.value = '';
  }
}

/* Results */

function showResults() {
  ui.warnings.replaceChildren(
    ...results.warnings.map((warning) => {
      const item = document.createElement('li');
      item.textContent = warningText(warning);
      return item;
    }),
  );

  LISTS.forEach((list, i) => {
    ui.tabs[i].querySelector('[data-count]').textContent = number.format(results[list.key].length);
  });

  showScreen('results');
  drawChart();
  selectTab(0, { focus: false });
  celebrate();
}

// A small card with the headline number. Closing it moves focus to the results.
function celebrate() {
  const missing = results.notFollowingBack.length;
  ui.celebrateTitle.textContent =
    missing === 0
      ? 'Everyone you follow follows you back!'
      : `${count(missing, "account doesn't", "accounts don't")} follow you back`;
  ui.celebrateDetail.textContent =
    `${count(results.mutual.length, 'mutual follower', 'mutual followers')} · ` +
    `${number.format(results.notFollowedBack.length)} you don't follow back`;

  if (typeof ui.celebrate.showModal !== 'function') {
    ui.resultsHeading.focus();
    return;
  }
  ui.celebrate.showModal();
  ui.celebrateOk.focus();
}

function closeCelebration() {
  if (ui.celebrate.open) ui.celebrate.close();
}

function drawChart() {
  const blue = results.notFollowingBack.length;
  const green = results.mutual.length;
  const gold = results.notFollowedBack.length;

  ui.chart.hidden = blue + green + gold === 0;
  ui.chartFollowing.textContent = count(results.following, 'following', 'following');
  ui.chartFollowers.textContent = count(results.followers, 'follower', 'followers');
  ui.chartText.textContent =
    `You follow ${count(results.following, 'account', 'accounts')} and ${count(results.followers, 'account follows', 'accounts follow')} you. ` +
    `${number.format(green)} mutual, ${number.format(blue)} not following back, ${number.format(gold)} you don't follow back.`;

  // Start at equal thirds, then settle to real proportions (see app.css).
  ui.chartGrid.style.setProperty('--columns', '100fr 100fr 100fr');
  void ui.chartGrid.offsetWidth;
  const columns = chartColumns(blue, green, gold);
  requestAnimationFrame(() => {
    if (results) ui.chartGrid.style.setProperty('--columns', columns);
  });
}

function selectTab(index, { focus = true } = {}) {
  results.active = index;
  ui.tabs.forEach((tab, i) => {
    const selected = i === index;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  ui.panel.setAttribute('aria-labelledby', ui.tabs[index].id);
  ui.description.textContent = LISTS[index].description;
  if (focus) ui.tabs[index].focus();
  renderList();
}

const normalizeQuery = (value) => value.trim().replace(/^@/, '').toLowerCase();

function renderList() {
  const query = normalizeQuery(ui.search.value);
  const all = results[LISTS[results.active].key];
  results.matches = query ? all.filter((name) => name.includes(query)) : all;
  results.shown = 0;
  ui.list.replaceChildren();
  appendRows();

  if (results.matches.length) {
    ui.note.textContent = '';
  } else if (!query) {
    ui.note.textContent = 'No accounts in this list.';
  } else {
    const elsewhere = LISTS.filter((list, i) => i !== results.active && results[list.key].some((name) => name.includes(query)));
    ui.note.textContent = elsewhere.length
      ? `No match in this list. Found in ${elsewhere.map((list) => list.name).join(' and ')}.`
      : 'No match in any list.';
  }
}

function appendRows() {
  const { matches } = results;
  const end = Math.min(results.shown + PAGE_SIZE, matches.length);
  const rows = document.createDocumentFragment();
  for (let i = results.shown; i < end; i++) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `${PROFILE_URL}${encodeURIComponent(matches[i])}/`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-describedby', 'opens-instagram');
    link.textContent = matches[i];
    item.append(link);
    rows.append(item);
  }
  ui.list.append(rows);
  results.shown = end;

  const remaining = matches.length - end;
  ui.more.hidden = remaining <= 0;
  ui.more.textContent = `Show ${number.format(Math.min(PAGE_SIZE, remaining))} more`;
}

/* Clearing */

function clearResults() {
  generation++;
  results = null;
  closeCelebration();
  ui.celebrateTitle.textContent = '';
  ui.celebrateDetail.textContent = '';
  ui.list.replaceChildren();
  ui.warnings.replaceChildren();
  ui.search.value = '';
  ui.fileInput.value = '';
  ui.note.textContent = '';
  ui.description.textContent = '';
  ui.chartFollowing.textContent = '';
  ui.chartFollowers.textContent = '';
  ui.chartText.textContent = '';
  ui.chartGrid.style.removeProperty('--columns');
  ui.more.hidden = true;
  for (const tab of ui.tabs) tab.querySelector('[data-count]').textContent = '';
  showScreen('start');
}

/* Events */

ui.choose.addEventListener('click', () => ui.fileInput.click());
ui.fileInput.addEventListener('change', () => importFiles(ui.fileInput.files));

ui.clear.addEventListener('click', () => {
  clearResults();
  setError('');
  ui.choose.focus();
});

ui.celebrateOk.addEventListener('click', closeCelebration);
// A tap on the dimmed backdrop also closes it.
ui.celebrate.addEventListener('click', (event) => {
  if (event.target === ui.celebrate) closeCelebration();
});
ui.celebrate.addEventListener('close', () => {
  if (results) ui.resultsHeading.focus();
});

ui.marqueeToggle.addEventListener('click', () => {
  const paused = ui.marquee.classList.toggle('is-paused');
  ui.marqueeToggle.textContent = paused ? 'Play' : 'Pause';
  ui.marqueeToggle.setAttribute('aria-label', paused ? 'Play moving words' : 'Pause moving words');
});

ui.search.addEventListener('input', () => {
  if (results) renderList();
});

ui.more.addEventListener('click', () => {
  if (results) appendRows();
});

ui.tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => results && selectTab(i));
  tab.addEventListener('keydown', (event) => {
    if (!results) return;
    const last = ui.tabs.length - 1;
    const next = {
      ArrowRight: i === last ? 0 : i + 1,
      ArrowDown: i === last ? 0 : i + 1,
      ArrowLeft: i === 0 ? last : i - 1,
      ArrowUp: i === 0 ? last : i - 1,
      Home: 0,
      End: last,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectTab(next);
  });
});

// Leaving the page clears everything. Merely hiding the tab does not, so
// people can switch to Instagram and back.
window.addEventListener('pagehide', () => {
  clearResults();
  setError('');
});

// The whole page accepts drops, and a missed drop never opens the file.
let dragDepth = 0;
const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
const canDrop = () => !busy && supported;

window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  if (hasFiles(event) && canDrop()) {
    dragDepth++;
    ui.plate.classList.add('is-dragging');
  }
});
window.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = hasFiles(event) && canDrop() ? 'copy' : 'none';
});
window.addEventListener('dragleave', (event) => {
  event.preventDefault();
  if (hasFiles(event) && --dragDepth <= 0) {
    dragDepth = 0;
    ui.plate.classList.remove('is-dragging');
  }
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  ui.plate.classList.remove('is-dragging');
  if (canDrop()) importFiles(event.dataTransfer?.files);
});

/* Start */

const supported = supportsDeflateRaw();
if (!supported) {
  ui.plate.classList.add('is-unsupported');
  ui.choose.hidden = true;
  setError(UNSUPPORTED);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
