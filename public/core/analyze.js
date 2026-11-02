// Compares the two lists. F is followers, G is following.

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function compare(followers, following) {
  const F = new Set(followers);
  const G = new Set(following);
  const notFollowingBack = [];
  const mutual = [];
  const notFollowedBack = [];
  for (const name of G) (F.has(name) ? mutual : notFollowingBack).push(name);
  for (const name of F) if (!G.has(name)) notFollowedBack.push(name);
  return {
    notFollowingBack: notFollowingBack.sort(byName),
    mutual: mutual.sort(byName),
    notFollowedBack: notFollowedBack.sort(byName),
    followers: F.size,
    following: G.size,
  };
}

/**
 * Grid columns for the chart: blue (not following back), green (mutual),
 * gold (you don't follow back). Weights are percentages so they never sum to
 * less than 1fr, and any non-empty group gets at least 2%.
 */
export function chartColumns(blue, green, gold) {
  const total = blue + green + gold;
  if (!total) return '0fr 0fr 0fr';
  return [blue, green, gold]
    .map((n) => (n ? Math.max(2, Math.round((n / total) * 10000) / 100) : 0))
    .map((weight) => `${weight}fr`)
    .join(' ');
}
