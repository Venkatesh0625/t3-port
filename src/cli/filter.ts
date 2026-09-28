import { shortPath, tildify } from "./paths.ts";
import type { Listed } from "./report.ts";

/**
 * Free-text filter over a listing.
 *
 * Every term must match somewhere in a row — its agent, session id, project, working directory
 * or title — so terms narrow rather than widen: `list codex web-app` is Codex sessions in web-app.
 * Matching runs over the same text the row displays, plus the untruncated paths behind it, so
 * something visible on screen is always findable and a shortened path still matches in full.
 */
export function haystack(row: Listed, label: string): string {
  const { session } = row;
  return [
    label,
    session.sessionId,
    session.title,
    row.project ?? "",
    row.project ? tildify(row.project) : "",
    session.cwd ?? "",
    session.cwd ? tildify(session.cwd) : "",
    row.mark,
  ]
    .join("\n")
    .toLowerCase();
}

export function matches(row: Listed, label: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const text = haystack(row, label);
  return terms.every((term) => text.includes(term.toLowerCase()));
}

export { shortPath };
