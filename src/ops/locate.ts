import { sep } from "node:path";
import { impliedRepoName, repoRootOf } from "../worktree.ts";
import type { Project } from "../t3/queries.ts";

/**
 * Work out which project a session belongs to.
 *
 * Shared by planning and listing so the two never disagree: what `list` shows in the project
 * column is where `import` would actually put the thread.
 */

export const under = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

export const nameOf = (path: string): string => path.split(sep).pop() || path;

/** The most specific project directly containing a directory. */
export function directlyEnclosing(all: readonly Project[], cwd: string): Project | null {
  const hits = all.filter((p) => under(cwd, p.workspaceRoot));
  if (hits.length === 0) return null;
  return hits.reduce((best, p) => (p.workspaceRoot.length > best.workspaceRoot.length ? p : best));
}

/**
 * The project owning a session's directory, following a worktree back to its repository.
 *
 * Only git is trusted: a live worktree resolves to its real main checkout. A deleted one can
 * only be guessed from the path shape, which becomes a suggestion instead — see `suggest`.
 */
export function enclosing(all: readonly Project[], cwd: string | null): Project | null {
  if (!cwd) return null;
  const direct = directlyEnclosing(all, cwd);
  if (direct) return direct;
  const repoRoot = repoRootOf(cwd);
  return repoRoot ? directlyEnclosing(all, repoRoot) : null;
}

/** A project whose directory name matches the repository a dead worktree path implies. */
export function suggest(all: readonly Project[], cwd: string | null): Project | null {
  if (!cwd) return null;
  const name = impliedRepoName(cwd);
  if (!name) return null;
  const matches = all.filter((p) => nameOf(p.workspaceRoot) === name);
  return matches.length === 1 ? matches[0]! : null;
}
