import { existsSync } from "node:fs";
import { basename, dirname, sep } from "node:path";

/**
 * Map a session's working directory back to the repository it belongs to.
 *
 * Agents run in throwaway git worktrees — T3's under ~/.t3/worktrees, Superset's under
 * ~/.superset/worktrees, Claude's beside the repo as <repo>.worktrees. A session that ran in
 * one has a cwd no project contains, so a plain prefix match files it under "no project" even
 * when the project is right there.
 */

/** The main repository root for a live worktree, via git. Null when the path is gone. */
export function repoRootOf(cwd: string): string | null {
  if (!existsSync(cwd)) return null;
  try {
    const run = Bun.spawnSync(
      ["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { stdout: "pipe", stderr: "ignore" },
    );
    if (!run.success) return null;
    const gitDir = run.stdout.toString().trim();
    if (!gitDir) return null;
    // <root>/.git for a normal checkout; a bare repo has no working tree to match.
    return basename(gitDir) === ".git" ? dirname(gitDir) : null;
  } catch {
    return null;
  }
}

/**
 * The repository name a worktree path implies, for directories that no longer exist.
 *
 * `.../worktrees/<repo>/<branch-ish>` covers the T3 and Superset layouts; `<repo>.worktrees/...`
 * covers Claude's. This is a guess from a path shape, so callers should offer it rather than
 * act on it.
 */
export function impliedRepoName(cwd: string): string | null {
  const beside = /^(.*)\.worktrees(?:\/|$)/.exec(cwd);
  if (beside?.[1]) return basename(beside[1]);

  const segments = cwd.split(sep);
  const at = segments.lastIndexOf("worktrees");
  if (at !== -1 && segments[at + 1]) return segments[at + 1]!;
  return null;
}
