/**
 * Shortest prefix that still identifies a session, like git's abbreviated hashes.
 *
 * A fixed eight characters is wrong for Codex: its ids are UUIDv7, whose first 48 bits are a
 * millisecond timestamp, so sessions started moments apart share a prefix — 25 of 78 local
 * rollouts collided at eight. Claude's v4 ids are random and never do. Growing the width until
 * every displayed id is unique keeps the column honest for both, and keeps what is printed
 * usable as a reference to `import`, which resolves by prefix.
 */
export const MIN_ABBREV = 8;

export function abbreviationWidth(ids: readonly string[], min = MIN_ABBREV): number {
  const longest = ids.reduce((n, id) => Math.max(n, id.length), min);
  for (let width = min; width < longest; width++) {
    const seen = new Set<string>();
    let collided = false;
    for (const id of ids) {
      const prefix = id.slice(0, width);
      if (seen.has(prefix)) {
        collided = true;
        break;
      }
      seen.add(prefix);
    }
    if (!collided) return width;
  }
  return longest;
}

/** An abbreviator for one listing, plus the column width it needs. */
export function abbreviate(ids: readonly string[]): { width: number; of: (id: string) => string } {
  const width = abbreviationWidth(ids);
  return { width, of: (id) => id.slice(0, width) };
}
