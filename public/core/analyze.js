// Compares the two lists. F is followers, G is following.

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Accepts a Map of username to every username its entry carries, or a plain
// list of usernames.
function toAccounts(list) {
  if (list instanceof Map) return list;
  const accounts = new Map();
  for (const name of list) accounts.set(name, new Set([name]));
  return accounts;
}

function allKeys(accounts) {
  const keys = new Set();
  for (const [name, aliases] of accounts) {
    keys.add(name);
    for (const alias of aliases) keys.add(alias);
  }
  return keys;
}

// An account counts as present if any of its names is on the other list, so a
// real follower is never reported as not following back over a naming mismatch.
const isIn = (name, aliases, keys) => keys.has(name) || [...aliases].some((alias) => keys.has(alias));

export function compare(followers, following) {
  const F = toAccounts(followers);
  const G = toAccounts(following);
  const followerKeys = allKeys(F);
  const followingKeys = allKeys(G);
  const notFollowingBack = [];
  const mutual = [];
  const notFollowedBack = [];
  for (const [name, aliases] of G) (isIn(name, aliases, followerKeys) ? mutual : notFollowingBack).push(name);
  for (const [name, aliases] of F) if (!isIn(name, aliases, followingKeys)) notFollowedBack.push(name);
  return {
    notFollowingBack: notFollowingBack.sort(byName),
    mutual: mutual.sort(byName),
    notFollowedBack: notFollowedBack.sort(byName),
    followers: F.size,
    following: G.size,
  };
}

/**
 * Grid columns for the chart: violet (not following back), pink (mutual),
 * orange (you don't follow back). Weights are percentages so they never sum to
 * less than 1fr, and any non-empty group gets at least 2%.
 */
export function chartColumns(following, mutual, followers) {
  const total = following + mutual + followers;
  if (!total) return '0fr 0fr 0fr';
  return [following, mutual, followers]
    .map((n) => (n ? Math.max(2, Math.round((n / total) * 10000) / 100) : 0))
    .map((weight) => `${weight}fr`)
    .join(' ');
}
