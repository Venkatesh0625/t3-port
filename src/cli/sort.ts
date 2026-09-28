import { PortError } from "../errors.ts";
import type { Listed } from "./report.ts";

/**
 * Orderings for a listing.
 *
 * Recency is the default because the session you want is usually the one you just had. Sorting
 * by project groups a repository's work together, which recency scatters.
 *
 * Within a group the order is by size, largest first: a group exists to be scanned, and the long
 * conversations are the ones worth finding in it. A two-turn session is rarely what anyone is
 * looking for, and recency has already had its chance at the top level.
 */
export const SORTS = ["recent", "project", "turns", "agent", "title"] as const;
export type Sort = (typeof SORTS)[number];

export function parseSort(value: string | boolean | undefined): Sort {
  if (value === undefined) return "recent";
  if (typeof value === "boolean" || !SORTS.includes(value as Sort)) {
    throw new PortError(`--sort takes one of: ${SORTS.join(", ")}`);
  }
  return value as Sort;
}

const recency = (a: Listed, b: Listed): number => b.session.stat.mtimeMs - a.session.stat.mtimeMs;

/** Largest first, then newest: how rows are ordered inside any group. */
const withinGroup = (a: Listed, b: Listed): number =>
  b.session.turns.length - a.session.turns.length || recency(a, b);

/** Unplaced sessions sort last: they are the ones with nothing to group under. */
const projectKey = (row: Listed): string => row.project ?? `￿${row.session.cwd ?? ""}`;

export function sortRows(rows: readonly Listed[], sort: Sort, label: (id: string) => string): Listed[] {
  const sorted = [...rows];
  switch (sort) {
    case "project":
      return sorted.sort((a, b) => projectKey(a).localeCompare(projectKey(b)) || withinGroup(a, b));
    case "turns":
      return sorted.sort((a, b) => b.session.turns.length - a.session.turns.length || recency(a, b));
    case "agent":
      return sorted.sort(
        (a, b) =>
          label(a.session.provider).localeCompare(label(b.session.provider)) ||
          projectKey(a).localeCompare(projectKey(b)) ||
          withinGroup(a, b),
      );
    case "title":
      return sorted.sort((a, b) => a.session.title.localeCompare(b.session.title) || recency(a, b));
    default:
      return sorted.sort(recency);
  }
}
