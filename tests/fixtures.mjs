// Synthetic Instagram downloads with invented usernames. The shapes follow
// Meta's published examples; check them against a real download by hand.

import { makeZip } from './zipwriter.mjs';

const WORDS = [
  'river', 'otter', 'maple', 'comet', 'lumen', 'pixel', 'ember', 'fjord', 'quill', 'tango',
  'mossy', 'basil', 'cobalt', 'dune', 'harbor', 'ivy', 'juniper', 'kelp', 'lilac', 'nimbus',
];

/** Deterministic, invented usernames such as "maple.otter_12". */
export function names(count, prefix = '') {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = WORDS[i % WORDS.length];
    const b = WORDS[Math.floor(i / WORDS.length) % WORDS.length];
    out.push(`${prefix}${a}.${b}_${i}`);
  }
  return out;
}

const TIMESTAMP = 1730000000;

export function record(name, style = 'value') {
  const href = `https://www.instagram.com/${name}`;
  switch (style) {
    case 'title':
      return { title: name, media_list_data: [], string_list_data: [{ href, timestamp: TIMESTAMP }] };
    case 'href':
      return { title: '', media_list_data: [], string_list_data: [{ href: `https://www.instagram.com/_u/${name}`, timestamp: TIMESTAMP }] };
    case 'labels':
      return {
        media: [],
        label_values: [
          { label: 'Nom', value: 'Display Name' },
          { label: 'Lien vers le profil', value: href, href },
        ],
        fbid: '17841400000000000',
      };
    default:
      return { title: '', media_list_data: [], string_list_data: [{ href, value: name, timestamp: TIMESTAMP }] };
  }
}

export const followersJson = (list, style) => JSON.stringify(list.map((n) => record(n, style)));
export const followingJson = (list, style) =>
  JSON.stringify({ relationships_following: list.map((n) => record(n, style)) });

export const CANARY = 'canary.leak_9137';

export const DECOY_NAMES = {
  'pending_follow_requests.json': 'decoy.pending',
  'following_hashtags.json': 'decoy.hashtag',
  'blocked_profiles.json': 'decoy.blocked',
  'close_friends.json': 'decoy.close',
  'recently_unfollowed_profiles.json': 'decoy.unfollowed',
};

/** Unrelated files every export carries, including decoys that look like lists. */
export function extraEntries(root = '', folder = 'connections/followers_and_following/') {
  const entries = [
    {
      name: `${root}your_instagram_activity/messages/inbox/friend_123/message_1.json`,
      data: JSON.stringify({ participants: [{ name: CANARY }], messages: [{ content: CANARY }], string_list_data: [{ value: CANARY }] }),
      // Stored, so tests can find the canary's exact bytes in the archive.
      method: 0,
    },
    {
      name: `${root}personal_information/personal_information/personal_information.json`,
      data: JSON.stringify([record(CANARY)]),
    },
    { name: `${root}media/posts/202401/photo.jpg`, data: Buffer.alloc(2048, 7), method: 0 },
    { name: `${root}your_instagram_activity/threads/followers.json`, data: followersJson(['decoy.threads']) },
    { name: `${root}${folder}threads/followers_1.json`, data: followersJson(['decoy.threads2']) },
    { name: `__MACOSX/${root}${folder}._followers_1.json`, data: Buffer.from([0, 5, 22, 7, 0, 2, 0, 0]), method: 0 },
  ];
  for (const [file, name] of Object.entries(DECOY_NAMES)) {
    entries.push({ name: `${root}${folder}${file}`, data: followersJson([name]) });
  }
  return entries;
}

/**
 * Builds a download. Options:
 * - layout: 'current' | 'older' | 'root'
 * - wrapper: folder name above everything (a re-zipped download)
 * - followerParts: number of followers_N.json parts
 * - style / followingStyle: record style for each list
 * - extras: include unrelated and decoy files (default true)
 */
export function buildExport({
  followers = [],
  following = [],
  layout = 'current',
  wrapper = '',
  followerParts = 1,
  followingParts = 0,
  style,
  followingStyle,
  extras = true,
  method = 8,
  zip64 = false,
  omit = [],
} = {}) {
  const root = wrapper ? `${wrapper}/` : '';
  const folder = { current: 'connections/followers_and_following/', older: 'followers_and_following/', root: '' }[layout];
  const entries = [];

  const size = Math.ceil(followers.length / followerParts) || 0;
  for (let p = 1; p <= followerParts; p++) {
    const name = `followers_${p}.json`;
    if (!omit.includes(name)) {
      entries.push({ name: `${root}${folder}${name}`, data: followersJson(followers.slice((p - 1) * size, p * size), style), method });
    }
  }

  if (followingParts) {
    const fsize = Math.ceil(following.length / followingParts) || 0;
    for (let p = 1; p <= followingParts; p++) {
      const name = `following_${p}.json`;
      if (!omit.includes(name)) {
        entries.push({ name: `${root}${folder}${name}`, data: followingJson(following.slice((p - 1) * fsize, p * fsize), followingStyle ?? style), method });
      }
    }
  } else if (!omit.includes('following.json')) {
    entries.push({ name: `${root}${folder}following.json`, data: followingJson(following, followingStyle ?? style), method });
  }

  if (extras) entries.push(...extraEntries(root, folder));
  return makeZip(entries, { zip64 });
}

/** A Blob as the browser would hand it over. */
export const blobOf = (zip) => new Blob([zip.buffer ?? zip]);
