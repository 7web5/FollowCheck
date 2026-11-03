// Finds the followers and following lists in one or more Instagram data
// downloads and returns only the usernames in them.

import { readDirectory, readEntry, ZipError, DEFAULT_MAX_ENTRY_BYTES } from './zip.js';

export class ImportError extends Error {
  constructor(code, list) {
    super(code);
    this.name = 'ImportError';
    this.code = code;
    this.list = list;
  }
}

const LIST_FILE = /^(followers|following)(?:_([1-9][0-9]{0,3}))?\.json$/;
const HTML_LIST_FILE = /^(followers|following)(?:_[0-9]+)?\.html$/;
const LIST_FOLDERS = new Set(['followers_and_following', 'connections']);

function pathParts(path) {
  if (path.endsWith('/')) return null;
  const parts = path.toLowerCase().split('/').filter(Boolean);
  if (!parts.length || parts.includes('threads') || parts.includes('__macosx')) return null;
  return parts;
}

function inListFolder(parts) {
  return parts.length === 1 || LIST_FOLDERS.has(parts[parts.length - 2]);
}

/**
 * Returns { list, part } for a followers or following file, otherwise null.
 * An unnumbered file is part 0.
 */
export function classifyPath(path) {
  const parts = pathParts(path);
  if (!parts || !inListFolder(parts)) return null;
  const match = LIST_FILE.exec(parts[parts.length - 1]);
  if (!match) return null;
  return { list: match[1], part: match[2] ? Number(match[2]) : 0 };
}

function isHtmlList(path) {
  const parts = pathParts(path);
  return Boolean(parts && inListFolder(parts) && HTML_LIST_FILE.test(parts[parts.length - 1]));
}

const VALID_USERNAME = /^[a-z0-9._]{1,30}$/;
const PROFILE_LINK = /^https?:\/\/(?:www\.|m\.)?instagram\.com\/(?:_u\/)?([^/?#\s]+)\/?(?:[?#].*)?$/i;

export function normalizeUsername(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/^@/, '').toLowerCase();
  return VALID_USERNAME.test(name) ? name : null;
}

function fromLink(href) {
  if (typeof href !== 'string') return null;
  const match = PROFILE_LINK.exec(href.trim());
  if (!match) return null;
  try {
    return normalizeUsername(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

// Labels are translated, so the profile is found by its link, not its label.
function fromLabelValues(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return null;
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const name = typeof item === 'string' ? fromLink(item) : fromLabelValues(item, depth + 1);
    if (name) return name;
  }
  return null;
}

export function usernameOf(record) {
  if (record === null || typeof record !== 'object') return null;
  const first = Array.isArray(record.string_list_data) ? record.string_list_data[0] : undefined;
  const item = first !== null && typeof first === 'object' ? first : {};
  return (
    normalizeUsername(item.value) ??
    normalizeUsername(record.title) ??
    fromLink(item.href) ??
    fromLabelValues(record.label_values)
  );
}

/**
 * Returns { name, keys } where name is shown to the user and keys holds every
 * username the record carries. Matching on all of them means a follower is
 * never missed just because two fields of one entry disagree.
 */
export function accountOf(record) {
  const name = usernameOf(record);
  if (!name) return null;
  const keys = new Set([name]);
  const add = (key) => key && keys.add(key);
  for (const item of Array.isArray(record.string_list_data) ? record.string_list_data : []) {
    if (item === null || typeof item !== 'object') continue;
    add(normalizeUsername(item.value));
    add(fromLink(item.href));
  }
  add(normalizeUsername(record.title));
  add(fromLabelValues(record.label_values));
  return { name, keys };
}

// Follow dates are in seconds; accept milliseconds too.
function timestampOf(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value > 1e11 ? value / 1000 : value;
}

function oldestDateOf(record) {
  let oldest = timestampOf(record.timestamp);
  for (const item of Array.isArray(record.string_list_data) ? record.string_list_data : []) {
    const t = item !== null && typeof item === 'object' ? timestampOf(item.timestamp) : null;
    if (t !== null && (oldest === null || t < oldest)) oldest = t;
  }
  return oldest;
}

function recordsOf(data) {
  if (Array.isArray(data)) return data;
  if (data === null || typeof data !== 'object') return null;
  const keys = Object.keys(data).filter((key) => key.startsWith('relationships_') && Array.isArray(data[key]));
  if (!keys.length) return null;
  return keys.flatMap((key) => data[key]);
}

/**
 * Parses one list file. Returns { accounts: [{ name, keys }], skipped, oldest }
 * where oldest is the earliest follow date in seconds. Everything else is discarded.
 */
export function parseList(bytes, list) {
  let data;
  try {
    // TextDecoder drops a leading byte order mark.
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ImportError('UNKNOWN_FORMAT', list);
  }
  const records = recordsOf(data);
  if (!records) throw new ImportError('UNKNOWN_FORMAT', list);
  const accounts = [];
  let skipped = 0;
  let oldest = null;
  for (const record of records) {
    const account = record !== null && typeof record === 'object' ? accountOf(record) : null;
    if (!account) {
      skipped++;
      continue;
    }
    accounts.push(account);
    const date = oldestDateOf(record);
    if (date !== null && (oldest === null || date < oldest)) oldest = date;
  }
  return { accounts, skipped, oldest };
}

function missingParts(parts) {
  const numbers = [...parts.keys()].filter((n) => n > 0);
  if (!numbers.length) return [];
  const missing = [];
  for (let n = 1; n < Math.max(...numbers); n++) if (!parts.has(n)) missing.push(n);
  return missing;
}

async function readList(parts, list, maxBytes) {
  const accounts = new Map();
  let skipped = 0;
  let oldest = null;
  for (const part of [...parts.keys()].sort((a, b) => a - b)) {
    const { file, entry } = parts.get(part);
    const parsed = parseList(await readEntry(file, entry, { maxBytes }), list);
    for (const { name, keys } of parsed.accounts) {
      const known = accounts.get(name);
      if (known) for (const key of keys) known.add(key);
      else accounts.set(name, keys);
    }
    skipped += parsed.skipped;
    if (parsed.oldest !== null && (oldest === null || parsed.oldest < oldest)) oldest = parsed.oldest;
  }
  return { accounts, skipped, oldest };
}

// A followers list whose oldest follow is this recent may come from a date
// range shorter than All time, so older followers could be missing.
const RECENT_RANGE_SECONDS = 400 * 24 * 60 * 60;

/**
 * Reads the followers and following lists from the selected ZIP files.
 * Returns { followers, following, warnings } where each list is a
 * Map of username to the set of every username its entry carries.
 */
export async function extractLists(
  files,
  { onProgress = () => {}, maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES, now = Date.now() / 1000 } = {},
) {
  try {
    onProgress('finding');
    const parts = { followers: new Map(), following: new Map() };
    let sawHtml = false;

    for (const file of files) {
      const kept = await readDirectory(file, (path) => {
        const found = classifyPath(path);
        if (found) return found;
        if (isHtmlList(path)) sawHtml = true;
        return undefined;
      });
      for (const { value, entry } of kept) {
        const map = parts[value.list];
        if (map.has(value.part)) throw new ImportError('MIXED_DOWNLOADS');
        map.set(value.part, { file, entry });
      }
    }

    if (!parts.followers.size && !parts.following.size) {
      throw new ImportError(sawHtml ? 'HTML_EXPORT' : 'NO_LISTS');
    }
    for (const map of Object.values(parts)) {
      for (const { entry } of map.values()) if (entry.encrypted) throw new ImportError('ENCRYPTED');
    }
    if (!parts.followers.size) throw new ImportError('FOLLOWERS_MISSING');
    if (!parts.following.size) throw new ImportError('FOLLOWING_MISSING');

    const warnings = [];
    for (const list of ['followers', 'following']) {
      const missing = missingParts(parts[list]);
      if (missing.length) warnings.push({ type: 'missing-parts', list, parts: missing });
    }

    onProgress('followers');
    const followers = await readList(parts.followers, 'followers', maxEntryBytes);
    onProgress('following');
    const following = await readList(parts.following, 'following', maxEntryBytes);

    for (const [list, result] of [['followers', followers], ['following', following]]) {
      if (result.skipped) warnings.push({ type: 'skipped', list, count: result.skipped });
    }
    if (followers.oldest !== null && now - followers.oldest < RECENT_RANGE_SECONDS) {
      warnings.push({ type: 'recent-range', list: 'followers', since: followers.oldest });
    }

    return { followers: followers.accounts, following: following.accounts, warnings };
  } catch (error) {
    if (error instanceof ZipError) throw new ImportError(error.code);
    throw error;
  }
}
