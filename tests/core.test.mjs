import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import { extractLists, classifyPath, usernameOf, normalizeUsername, ImportError } from '../public/core/extract.js';
import { compare, chartColumns } from '../public/core/analyze.js';
import { readDirectory, readEntry, DEFAULT_MAX_ENTRY_BYTES } from '../public/core/zip.js';
import { makeZip } from './zipwriter.mjs';
import { names, buildExport, blobOf, followersJson, followingJson, CANARY, DECOY_NAMES, record } from './fixtures.mjs';

const FOLDER = 'connections/followers_and_following/';

async function run(...zips) {
  const lists = await extractLists(zips.map(blobOf));
  return { ...lists, ...compare(lists.followers, lists.following) };
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ImportError, `expected ImportError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

const listZip = (entries, options) => makeZip(entries, options);

describe('comparison', () => {
  test('sorts accounts into the three lists', async () => {
    const r = await run(buildExport({
      followers: ['bea', 'cal', 'dex', 'eli'],
      following: ['ana', 'cal', 'eli', 'zed'],
    }));
    assert.deepEqual(r.notFollowingBack, ['ana', 'zed']);
    assert.deepEqual(r.mutual, ['cal', 'eli']);
    assert.deepEqual(r.notFollowedBack, ['bea', 'dex']);
    assert.equal(r.followers, 4);
    assert.equal(r.following, 4);
  });

  test('matches case-insensitively, strips @ and de-duplicates', async () => {
    const r = await run(makeZip([
      { name: `${FOLDER}followers_1.json`, data: followersJson(['Ana', '@bea', ' bea ', 'ana']) },
      { name: `${FOLDER}following.json`, data: followingJson(['ANA', 'cal', 'Cal']) },
    ]));
    assert.deepEqual(r.mutual, ['ana']);
    assert.deepEqual(r.notFollowedBack, ['bea']);
    assert.deepEqual(r.notFollowingBack, ['cal']);
    assert.equal(r.followers, 2);
    assert.equal(r.following, 2);
  });

  test('sorts alphabetically', () => {
    const r = compare([], ['zed', 'amy', 'mo_1', 'mo.1', '0x']);
    assert.deepEqual(r.notFollowingBack, ['0x', 'amy', 'mo.1', 'mo_1', 'zed']);
  });

  test('chart columns are percentages with a 2% floor', () => {
    assert.equal(chartColumns(60, 120, 80), '23.08fr 46.15fr 30.77fr');
    assert.equal(chartColumns(1, 1000, 0), '2fr 99.9fr 0fr');
    assert.equal(chartColumns(0, 0, 0), '0fr 0fr 0fr');
    assert.doesNotMatch(chartColumns(3, 4, 5), /calc/);
  });
});

describe('usernames', () => {
  test('reads value, title, href and label_values records', async () => {
    for (const style of ['value', 'title', 'href', 'labels']) {
      const r = await run(buildExport({ followers: ['ana', 'bea'], following: ['bea', 'cal'], style }));
      assert.deepEqual(r.mutual, ['bea'], style);
      assert.deepEqual(r.notFollowingBack, ['cal'], style);
      assert.deepEqual(r.notFollowedBack, ['ana'], style);
    }
  });

  test('prefers the first valid source', () => {
    assert.equal(usernameOf({ title: 'Display Name', string_list_data: [{ value: 'real', href: 'https://www.instagram.com/other' }] }), 'real');
    assert.equal(usernameOf({ title: 'Display Name', string_list_data: [{ href: 'https://www.instagram.com/_u/linked/' }] }), 'linked');
    assert.equal(usernameOf({ title: 'ok.name', string_list_data: [{ value: 'not valid!' }] }), 'ok.name');
    assert.equal(usernameOf({ label_values: [{ label: 'URL', value: 'https://instagram.com/deep' }] }), 'deep');
    assert.equal(usernameOf({ label_values: [{ label: 'Username', value: 'no_link' }] }), null);
    assert.equal(usernameOf(null), null);
  });

  test('normalizes and validates', () => {
    assert.equal(normalizeUsername('  @Some.User_1 '), 'some.user_1');
    assert.equal(normalizeUsername('a'.repeat(30)), 'a'.repeat(30));
    assert.equal(normalizeUsername('a'.repeat(31)), null);
    assert.equal(normalizeUsername('has space'), null);
    assert.equal(normalizeUsername('émile'), null);
    assert.equal(normalizeUsername(''), null);
    assert.equal(normalizeUsername(42), null);
  });

  test('counts unreadable records as skipped', async () => {
    const followers = JSON.stringify([record('ana'), { title: '', string_list_data: [{}] }, { nonsense: true }, 'text']);
    const r = await extractLists([blobOf(makeZip([
      { name: `${FOLDER}followers_1.json`, data: followers },
      { name: `${FOLDER}following.json`, data: followingJson(['ana']) },
    ]))]);
    assert.deepEqual([...r.followers.keys()], ['ana']);
    assert.deepEqual(r.warnings, [{ type: 'skipped', list: 'followers', count: 3 }]);
  });

  test('accepts empty lists', async () => {
    const r = await run(buildExport({ followers: [], following: ['ana'] }));
    assert.equal(r.followers, 0);
    assert.deepEqual(r.notFollowingBack, ['ana']);
    const empty = await run(buildExport({ followers: ['bea'], following: [] }));
    assert.deepEqual(empty.notFollowedBack, ['bea']);
  });

  test('accepts any relationships_ key and a UTF-8 byte order mark', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const r = await run(makeZip([
      { name: `${FOLDER}followers_1.json`, data: Buffer.concat([bom, Buffer.from(JSON.stringify({ relationships_followers: [record('ana')] }))]) },
      { name: `${FOLDER}following.json`, data: Buffer.concat([bom, Buffer.from(followingJson(['ana']))]) },
    ]));
    assert.deepEqual(r.mutual, ['ana']);
  });
});

describe('never a false "not following back"', () => {
  const zipOf = (followers, following) => makeZip([
    { name: `${FOLDER}followers_1.json`, data: JSON.stringify(followers) },
    { name: `${FOLDER}following.json`, data: JSON.stringify({ relationships_following: following }) },
  ]);

  test('matches an entry by its link when its title is a different name', async () => {
    // Following shows "old_name" as the title, but the profile link is "ana".
    const r = await run(zipOf(
      [record('ana')],
      [{ title: 'old_name', string_list_data: [{ href: 'https://www.instagram.com/_u/ana', timestamp: 1730000000 }] }],
    ));
    assert.deepEqual(r.notFollowingBack, []);
    assert.deepEqual(r.mutual, ['old_name']);
    assert.deepEqual(r.notFollowedBack, []);
  });

  test('matches on the follower side too', async () => {
    const r = await run(zipOf(
      [{ title: '', string_list_data: [{ value: 'shown_name', href: 'https://www.instagram.com/ana', timestamp: 1730000000 }] }],
      [record('ana')],
    ));
    assert.deepEqual(r.notFollowingBack, []);
    assert.deepEqual(r.notFollowedBack, []);
  });

  test('reads every item in string_list_data, not just the first', async () => {
    const r = await run(zipOf(
      [record('ana')],
      [{ title: '', string_list_data: [{ value: 'first_name' }, { value: 'ana' }] }],
    ));
    assert.deepEqual(r.notFollowingBack, []);
  });

  test('matches through label_values links', async () => {
    const r = await run(zipOf(
      [record('ana', 'labels')],
      [{ title: 'other', label_values: [{ label: 'Profil', href: 'https://www.instagram.com/ana/' }] }],
    ));
    assert.deepEqual(r.notFollowingBack, []);
  });

  test('accounts that truly differ still show as not following back', async () => {
    const r = await run(zipOf([record('ana')], [record('bea'), record('ana')]));
    assert.deepEqual(r.notFollowingBack, ['bea']);
    assert.deepEqual(r.mutual, ['ana']);
  });

  test('warns when the followers list looks limited to a short date range', async () => {
    const day = 24 * 60 * 60;
    const now = 1_790_000_000;
    const recent = [{ title: '', string_list_data: [{ value: 'ana', timestamp: now - 90 * day }] }];
    const lists = await extractLists([blobOf(zipOf(recent, [record('ana')]))], { now });
    assert.deepEqual(lists.warnings, [{ type: 'recent-range', list: 'followers', since: now - 90 * day }]);

    const old = [{ title: '', string_list_data: [{ value: 'ana', timestamp: now - 900 * day }] }, ...recent];
    const full = await extractLists([blobOf(zipOf(old, [record('ana')]))], { now });
    assert.deepEqual(full.warnings, []);

    const millis = [{ title: '', string_list_data: [{ value: 'ana', timestamp: (now - 90 * day) * 1000 }] }];
    const ms = await extractLists([blobOf(zipOf(millis, [record('ana')]))], { now });
    assert.equal(ms.warnings[0]?.since, now - 90 * day);
  });

  test('no date warning when follow dates are missing', async () => {
    const lists = await extractLists([blobOf(zipOf([{ title: 'ana' }], [{ title: 'ana' }]))], { now: 1_790_000_000 });
    assert.deepEqual(lists.warnings, []);
  });
});

describe('archive layouts', () => {
  const people = { followers: ['ana', 'bea'], following: ['bea', 'cal'] };

  for (const layout of ['current', 'older', 'root']) {
    test(`reads the ${layout} layout`, async () => {
      const r = await run(buildExport({ ...people, layout }));
      assert.deepEqual(r.mutual, ['bea']);
    });
  }

  test('reads a re-zipped archive with a wrapper folder', async () => {
    for (const layout of ['current', 'older']) {
      const r = await run(buildExport({ ...people, layout, wrapper: 'instagram-someone-2026-01-01' }));
      assert.deepEqual(r.mutual, ['bea']);
    }
  });

  test('reads stored (uncompressed) entries', async () => {
    const r = await run(buildExport({ ...people, method: 0 }));
    assert.deepEqual(r.mutual, ['bea']);
  });

  test('reads ZIP64 records and 64-bit entry fields', async () => {
    const r = await run(makeZip([
      { name: `${FOLDER}followers_1.json`, data: followersJson(people.followers), zip64: true },
      { name: `${FOLDER}following.json`, data: followingJson(people.following), zip64: true, method: 0 },
    ], { zip64: true }));
    assert.deepEqual(r.mutual, ['bea']);
  });

  test('reads a ZIP64 archive with more than 65,535 entries', async () => {
    const entries = [];
    for (let i = 0; i < 66000; i++) entries.push({ name: `media/stories/${i}.txt`, data: '', method: 0 });
    entries.push({ name: `${FOLDER}followers_1.json`, data: followersJson(people.followers) });
    entries.push({ name: `${FOLDER}following.json`, data: followingJson(people.following) });
    const r = await run(makeZip(entries));
    assert.deepEqual(r.mutual, ['bea']);
  });

  test('reads an archive with a comment', async () => {
    const zip = makeZip([
      { name: `${FOLDER}followers_1.json`, data: followersJson(['ana']) },
      { name: `${FOLDER}following.json`, data: followingJson(['ana']) },
    ], { comment: 'exported' });
    assert.deepEqual((await run(zip)).mutual, ['ana']);
  });
});

describe('file allowlist', () => {
  test('accepts list files in known places', () => {
    assert.deepEqual(classifyPath('connections/followers_and_following/followers_1.json'), { list: 'followers', part: 1 });
    assert.deepEqual(classifyPath('followers_and_following/following.json'), { list: 'following', part: 0 });
    assert.deepEqual(classifyPath('wrap/connections/followers_and_following/Followers_12.JSON'), { list: 'followers', part: 12 });
    assert.deepEqual(classifyPath('connections/following_2.json'), { list: 'following', part: 2 });
    assert.deepEqual(classifyPath('followers.json'), { list: 'followers', part: 0 });
  });

  test('rejects everything else', () => {
    for (const path of [
      `${FOLDER}pending_follow_requests.json`,
      `${FOLDER}following_hashtags.json`,
      `${FOLDER}blocked_profiles.json`,
      `${FOLDER}close_friends.json`,
      `${FOLDER}recently_unfollowed_profiles.json`,
      'threads/followers.json',
      'your_instagram_activity/threads/followers.json',
      `threads/${FOLDER}followers_1.json`,
      `${FOLDER}threads/followers_1.json`,
      `__MACOSX/${FOLDER}._followers_1.json`,
      `__MACOSX/${FOLDER}followers_1.json`,
      `${FOLDER}._followers_1.json`,
      `${FOLDER}followers_1.json.bak`,
      `${FOLDER}followers_1.html`,
      `${FOLDER}followers_0.json`,
      `${FOLDER}my_followers_1.json`,
      'messages/followers_1.json',
      'wrapper/followers_1.json',
      `${FOLDER}followers_1.json/`,
    ]) {
      assert.equal(classifyPath(path), null, path);
    }
  });

  test('decoy files never reach the results', async () => {
    const r = await run(buildExport({ followers: ['ana'], following: ['bea'] }));
    const everyone = [...r.notFollowingBack, ...r.mutual, ...r.notFollowedBack];
    for (const decoy of [...Object.values(DECOY_NAMES), 'decoy.threads', 'decoy.threads2', CANARY]) {
      assert.ok(!everyone.includes(decoy), decoy);
    }
    assert.ok(!JSON.stringify(r).includes(CANARY));
    assert.deepEqual(everyone.sort(), ['ana', 'bea']);
  });

  test('only the list entries are read', async () => {
    const zip = buildExport({ followers: names(50), following: names(30) });
    const blob = blobOf(zip);
    const reads = [];
    const recording = { size: blob.size, slice: (start, end) => (reads.push([start, end]), blob.slice(start, end)) };
    await extractLists([recording]);

    const lists = new Set([`${FOLDER}followers_1.json`, `${FOLDER}following.json`]);
    assert.ok(reads.length > 0);
    for (const [name, range] of zip.ranges) {
      if (lists.has(name)) continue;
      for (const [start, end] of reads) {
        assert.ok(end <= range.start || start >= range.end, `read [${start}, ${end}) overlaps ${name}`);
      }
    }
    // The canary bytes are inside an unrelated entry, so they were never read.
    const canaryAt = zip.buffer.indexOf(CANARY);
    assert.ok(canaryAt > 0);
    for (const [start, end] of reads) assert.ok(canaryAt < start || canaryAt >= end);
  });

  test('filenames of unrelated entries are not kept', async () => {
    const seen = [];
    const kept = await readDirectory(blobOf(buildExport({ followers: ['ana'], following: ['ana'] })), (name) => {
      seen.push(name);
      return classifyPath(name) ?? undefined;
    });
    assert.ok(seen.length > 5);
    assert.equal(kept.length, 2);
    for (const { value, entry } of kept) {
      assert.deepEqual(Object.keys(value).sort(), ['list', 'part']);
      assert.ok(!JSON.stringify(entry).includes('/'));
    }
  });
});

describe('multiple parts and files', () => {
  test('merges numbered parts of both lists', async () => {
    const followers = names(90);
    const following = names(60, 'f');
    const r = await run(buildExport({ followers, following: [...following, followers[0]], followerParts: 3, followingParts: 2 }));
    assert.equal(r.followers, 90);
    assert.equal(r.following, 61);
    assert.deepEqual(r.mutual, [followers[0]]);
  });

  test('warns when a numbered part is missing', async () => {
    const lists = await extractLists([blobOf(buildExport({
      followers: names(90), following: ['ana'], followerParts: 3, omit: ['followers_2.json'],
    }))]);
    assert.deepEqual(lists.warnings, [{ type: 'missing-parts', list: 'followers', parts: [2] }]);
    assert.equal(lists.followers.size, 60);
  });

  test('reads a download split across ZIPs', async () => {
    const followers = names(40);
    const all = buildExport({ followers, following: ['ana'], followerParts: 2, extras: false });
    const partOne = makeZip([
      { name: `${FOLDER}followers_1.json`, data: followersJson(followers.slice(0, 20)) },
      { name: 'messages/x.json', data: '{}' },
    ]);
    const partTwo = makeZip([
      { name: `${FOLDER}followers_2.json`, data: followersJson(followers.slice(20)) },
      { name: `${FOLDER}following.json`, data: followingJson(['ana']) },
    ]);
    const split = await run(partOne, partTwo);
    const whole = await run(all);
    assert.equal(split.followers, 40);
    assert.deepEqual(split.notFollowedBack, whole.notFollowedBack);
    assert.deepEqual(split.warnings, []);
  });

  test('rejects two separate downloads', async () => {
    const a = buildExport({ followers: ['ana'], following: ['bea'] });
    const b = buildExport({ followers: ['cal'], following: ['dex'] });
    await rejectsWith(extractLists([blobOf(a), blobOf(b)]), 'MIXED_DOWNLOADS');
    await rejectsWith(extractLists([blobOf(a), blobOf(a)]), 'MIXED_DOWNLOADS');
  });
});

describe('errors', () => {
  test('not a ZIP', async () => {
    await rejectsWith(extractLists([new Blob(['{"relationships_following": []}'])]), 'NOT_ZIP');
    await rejectsWith(extractLists([new Blob([''])]), 'NOT_ZIP');
    await rejectsWith(extractLists([new Blob([Buffer.alloc(100_000, 1)])]), 'NOT_ZIP');
  });

  test('HTML export', async () => {
    await rejectsWith(extractLists([blobOf(makeZip([
      { name: `${FOLDER}followers_1.html`, data: '<html></html>' },
      { name: `${FOLDER}following.html`, data: '<html></html>' },
    ]))]), 'HTML_EXPORT');
  });

  test('no lists', async () => {
    await rejectsWith(extractLists([blobOf(makeZip([{ name: 'messages/inbox/a/message_1.json', data: '{}' }]))]), 'NO_LISTS');
    await rejectsWith(extractLists([blobOf(makeZip([]))]), 'NO_LISTS');
  });

  test('followers missing', async () => {
    await rejectsWith(extractLists([blobOf(makeZip([{ name: `${FOLDER}following.json`, data: followingJson(['ana']) }]))]), 'FOLLOWERS_MISSING');
  });

  test('following missing', async () => {
    await rejectsWith(extractLists([blobOf(makeZip([{ name: `${FOLDER}followers_1.json`, data: followersJson(['ana']) }]))]), 'FOLLOWING_MISSING');
  });

  test('password protected', async () => {
    await rejectsWith(extractLists([blobOf(makeZip([
      { name: `${FOLDER}followers_1.json`, data: 'xxxx', encrypted: true },
      { name: `${FOLDER}following.json`, data: 'xxxx', encrypted: true },
    ]))]), 'ENCRYPTED');
  });

  test('damaged: truncated archive', async () => {
    const zip = buildExport({ followers: ['ana'], following: ['bea'] }).buffer;
    await rejectsWith(extractLists([new Blob([zip.subarray(0, zip.length - 400)])]), 'DAMAGED');
  });

  test('damaged: a corrupted byte fails the CRC check', async () => {
    const zip = makeZip([
      { name: `${FOLDER}followers_1.json`, data: followersJson(['ana', 'bea']), method: 0 },
      { name: `${FOLDER}following.json`, data: followingJson(['ana']) },
    ]);
    const bytes = Buffer.from(zip.buffer);
    const at = bytes.indexOf('"bea"') + 1;
    bytes[at] = 'c'.charCodeAt(0);
    await rejectsWith(extractLists([new Blob([bytes])]), 'DAMAGED');
  });

  test('damaged: wrong declared CRC on a deflated entry', async () => {
    await rejectsWith(extractLists([blobOf(makeZip([
      { name: `${FOLDER}followers_1.json`, data: followersJson(['ana']), crc: 1234 },
      { name: `${FOLDER}following.json`, data: followingJson(['ana']) },
    ]))]), 'DAMAGED');
  });

  test('damaged: invalid deflate data', async () => {
    await rejectsWith(extractLists([blobOf(makeZip([
      { name: `${FOLDER}followers_1.json`, data: 'x', compressed: Buffer.from([0xff, 0xff, 0xff, 0xff]), size: 1 },
      { name: `${FOLDER}following.json`, data: followingJson(['ana']) },
    ]))]), 'DAMAGED');
  });

  test('too large: declared size over the limit', async () => {
    await rejectsWith(extractLists([blobOf(makeZip([
      { name: `${FOLDER}followers_1.json`, data: '[]', size: DEFAULT_MAX_ENTRY_BYTES + 1 },
      { name: `${FOLDER}following.json`, data: followingJson(['ana']) },
    ]))]), 'TOO_LARGE');
  });

  test('a decompression bomb that lies about its size is stopped by real output', async () => {
    const limit = 1024 * 1024;
    const bomb = deflateRawSync(Buffer.alloc(20 * limit, 0x20));
    const zip = (size) => blobOf(makeZip([
      { name: `${FOLDER}followers_1.json`, data: '[]', compressed: bomb, size },
      { name: `${FOLDER}following.json`, data: followingJson(['ana']) },
    ]));
    // Claims to be exactly at the limit: stopped once real output passes it.
    await rejectsWith(extractLists([zip(limit)], { maxEntryBytes: limit }), 'TOO_LARGE');
    // Claims to be tiny: stopped as soon as output passes the claim.
    await rejectsWith(extractLists([zip(2)], { maxEntryBytes: limit }), 'DAMAGED');
    assert.equal(DEFAULT_MAX_ENTRY_BYTES, 256 * 1024 * 1024);
  });

  test('unknown format', async () => {
    for (const data of ['{"something_else": []}', 'not json', '"string"', 'null', '{"relationships_following": {}}']) {
      await assert.rejects(
        extractLists([blobOf(makeZip([
          { name: `${FOLDER}followers_1.json`, data },
          { name: `${FOLDER}following.json`, data: followingJson(['ana']) },
        ]))]),
        (error) => error.code === 'UNKNOWN_FORMAT' && error.list === 'followers',
        data,
      );
    }
  });

  test('unsupported compression method counts as damaged', async () => {
    const zip = makeZip([
      { name: `${FOLDER}followers_1.json`, data: followersJson(['ana']), method: 0 },
      { name: `${FOLDER}following.json`, data: followingJson(['ana']) },
    ]);
    const kept = await readDirectory(blobOf(zip), (name) => classifyPath(name) ?? undefined);
    await assert.rejects(readEntry(blobOf(zip), { ...kept[0].entry, method: 12 }), { code: 'DAMAGED' });
  });
});

describe('performance', () => {
  test('200,000 followers and 7,500 following in under 5 seconds', async () => {
    const followers = names(200_000);
    const following = [...names(5_000), ...names(2_500, 'x')];
    const zip = blobOf(buildExport({ followers, following, followerParts: 4, extras: false }));
    const started = performance.now();
    const lists = await extractLists([zip]);
    const r = compare(lists.followers, lists.following);
    const elapsed = performance.now() - started;
    assert.equal(r.followers, 200_000);
    assert.equal(r.mutual.length, 5_000);
    assert.equal(r.notFollowingBack.length, 2_500);
    assert.ok(elapsed < 5000, `took ${Math.round(elapsed)} ms`);
  });
});
