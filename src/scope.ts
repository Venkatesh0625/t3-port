import { sep } from "node:path";
import { impliedRepoName, repoRootOf } from "./worktree.ts";

/**
 * Restricting a listing to one checkout and the worktrees made from it.
 *
 * Agents run in throwaway worktrees — T3's under ~/.t3/worktrees, Superset's under
 * ~/.superset/worktrees, Claude's beside the repo as <repo>.worktrees — so a directory scope
 * that only matched a path prefix would miss most of a repository's work.
 */
export interface Scope {
  readonly root: string;
  readonly name: string;
}

export const makeScope = (root: string): Scope => ({
  root,
  name: root.split(sep).pop() || root,
});

const isUnder = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * Whether a working directory belongs to a scope.
 *
 * `exact` is a decision from the path alone, which is all that is available before a transcript
 * is opened; `null` means the path is inconclusive and only git can say.
 */
export function pathSuggestsScope(cwd: string, scope: Scope): boolean | null {
  if (isUnder(cwd, scope.root)) return true;
  const implied = impliedRepoName(cwd);
  if (implied !== null) return implied === scope.name;
  return null;
}

/** The full test, which may consult git for a live worktree the path shape cannot place. */
export function inScope(cwd: string | null, scope: Scope): boolean {
  if (!cwd) return false;
  const fromPath = pathSuggestsScope(cwd, scope);
  if (fromPath !== null) return fromPath;
  const repoRoot = repoRootOf(cwd);
  return repoRoot !== null && isUnder(repoRoot, scope.root);
}
