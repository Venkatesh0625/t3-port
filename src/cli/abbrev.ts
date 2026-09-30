/**
 * Shortest prefix that still identifies a session, like git's abbreviated hashes.
 *
 * A fixed eight characters is wrong for Codex: its ids are UUIDv7, whose first 48 bits are a
 * millisecond timestamp, so sessions started moments apart share a prefix — 25 of 78 local
 * rollouts collided at eight. Claude's v4 ids are random and never do.
 *
 * Uniqueness is measured against `universe`, not against the ids on show. A printed id is meant
 * to be handed back to `import`, which searches every session of every agent on disk; a prefix
 * that is unique within one checkout's listing was once printed and then refused as ambiguous,
 * because a session elsewhere shared it.
 *
 * Where the ids are UUIDs the width is rounded out to a hyphen, so a longer id reads as whole
 * groups (`01a0e776-ab49`) rather than stopping mid-group (`01a0e776-a`). Either form is a
 * genuine prefix, so whatever is printed resolves.
 */
export const MIN_ABBREV = 8;

/** Prefix lengths that end just before a hyphen in 8-4-4-4-12. */
const UUID_BOUNDARIES = [8, 13, 18, 23, 36] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const commonPrefix = (a: string, b: string): number => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};

/**
 * One width for every id in `shown`, so the column stays aligned, wide enough that each is
 * unique among `universe`.
 *
 * The same id twice is one session — Claude keeps copies of a transcript under several project
 * directories, and resolving treats them as one — so repeats are not a collision.
 */
export function abbreviationWidth(
  shown: readonly string[],
  universe: readonly string[],
  min = MIN_ABBREV,
): number {
  if (shown.length === 0) return min;
  const all = [...new Set([...universe, ...shown])].sort();
  const at = new Map(all.map((id, i) => [id, i]));

  // In sorted order the id sharing the longest prefix with any given one is a neighbour.
  let need = min;
  for (const id of new Set(shown)) {
    const i = at.get(id)!;
    for (const other of [all[i - 1], all[i + 1]]) {
      if (other !== undefined) need = Math.max(need, Math.min(commonPrefix(id, other) + 1, id.length));
    }
  }

  if (!shown.every((id) => UUID.test(id))) return need;
  return UUID_BOUNDARIES.find((w) => w >= need) ?? need;
}

/** An abbreviator for one listing, plus the column width it needs. */
export function abbreviate(
  shown: readonly string[],
  universe: readonly string[],
): { width: number; of: (id: string) => string } {
  const width = abbreviationWidth(shown, universe);
  return { width, of: (id) => id.slice(0, width) };
}
