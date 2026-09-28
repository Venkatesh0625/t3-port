/**
 * Shortest prefix that still identifies a session, like git's abbreviated hashes.
 *
 * A fixed eight characters is wrong for Codex: its ids are UUIDv7, whose first 48 bits are a
 * millisecond timestamp, so sessions started moments apart share a prefix — 25 of 78 local
 * rollouts collided at eight. Claude's v4 ids are random and never do.
 *
 * Where the ids are UUIDs the width is rounded out to a hyphen, so a longer id reads as whole
 * groups (`01a0e776-ab49`) rather than stopping mid-group (`01a0e776-a`). Either form is a
 * genuine prefix, so whatever is printed can be handed back to `import`, which resolves by one.
 */
export const MIN_ABBREV = 8;

/** Prefix lengths that end just before a hyphen in 8-4-4-4-12. */
const UUID_BOUNDARIES = [8, 13, 18, 23, 36] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const unique = (ids: readonly string[], width: number): boolean =>
  new Set(ids.map((id) => id.slice(0, width))).size === ids.length;

export function abbreviationWidth(ids: readonly string[], min = MIN_ABBREV): number {
  if (ids.length === 0) return min;
  const longest = ids.reduce((n, id) => Math.max(n, id.length), min);

  // Duplicated ids can never be told apart; stop rather than walk to the end for nothing.
  if (new Set(ids).size !== ids.length) return longest;

  const widths =
    ids.every((id) => UUID.test(id))
      ? UUID_BOUNDARIES.filter((w) => w >= min)
      : Array.from({ length: longest - min + 1 }, (_, i) => min + i);

  return widths.find((width) => unique(ids, width)) ?? longest;
}

/** An abbreviator for one listing, plus the column width it needs. */
export function abbreviate(ids: readonly string[]): { width: number; of: (id: string) => string } {
  const width = abbreviationWidth(ids);
  return { width, of: (id) => id.slice(0, width) };
}
