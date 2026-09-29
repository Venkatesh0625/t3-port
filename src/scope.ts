import { sep } from "node:path";
import { impliedRepoName, repoRootOf } from "./worktree.ts";

/**
 * Restricting a listing to one checkout and the worktrees made from it.
 *
 * A scope names a checkout, not a directory tree. Those coincide for `--path ~/code/app` and
 * come apart at `--path ~`, where "anything underneath" is every session on the machine: work
 * done in `~/code/app` belongs to that checkout, not to the home directory that happens to
 * contain it. So a session is in scope when the repository it ran in *is* the scope, rather
 * than when its path sits below it.
 *
 * Agents also run in throwaway worktrees — T3's under ~/.t3/worktrees, Superset's under
 * ~/.superset/worktrees, Claude's beside the repo as <repo>.worktrees — which belong to their
 * repository however far from it they are kept.
 */
export interface Scope {
  readonly root: string;
  /** The repository whose worktrees belong to this scope. */
  readonly name: string;
  /** Whether the scope is itself a worktree, which owns nothing but itself. */
  readonly isWorktree: boolean;
}

export const makeScope = (root: string): Scope => ({
  root,
  name: root.split(sep).pop() || root,
  // Pointing at a worktree means that worktree. It has no worktrees of its own, and the sibling
  // checkouts of the repository it came from are not what was asked for.
  isWorktree: impliedRepoName(root) !== null,
});

const isUnder = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * A decision from the path alone, which is all that is available before a transcript is read.
 *
 * `null` means the path is inconclusive: only git can say which checkout a directory belongs to,
 * and the directory may not exist any more. Callers use this to narrow cheaply and must err
 * towards keeping, since the full test runs later.
 */
export function pathSuggestsScope(cwd: string, scope: Scope): boolean | null {
  // The scope itself, always. Asking about a worktree and being told nothing ran there because
  // the path looks like a worktree is the failure this ordering exists to prevent.
  if (cwd === scope.root) return true;

  // A worktree owns nothing beyond itself, so anything else is out — including the sibling
  // worktrees of the repository it was made from. Its own subdirectories are decided here
  // rather than deferred: git would answer with the main checkout, which is not this scope.
  if (scope.isWorktree) return isUnder(cwd, scope.root);

  const implied = impliedRepoName(cwd);
  if (implied !== null) return implied === scope.name;

  // Below the scope: a subdirectory of this checkout, or a different checkout entirely. Git
  // decides.
  return isUnder(cwd, scope.root) ? null : false;
}

/** The full test. */
export function inScope(cwd: string | null, scope: Scope): boolean {
  if (!cwd) return false;

  const fromPath = pathSuggestsScope(cwd, scope);
  if (fromPath !== null) return fromPath;

  // Inside a repository, the repository is the scope — so a session run in a checkout below the
  // scope belongs to that checkout, not to this one.
  const repoRoot = repoRootOf(cwd);
  if (repoRoot !== null) return repoRoot === scope.root;

  // Not a repository at all: only the directory itself counts, which keeps `--path ~` from
  // swallowing every unrelated folder in the home directory.
  return cwd === scope.root;
}
