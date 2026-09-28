import { basename, sep } from "node:path";
import { tildify } from "./paths.ts";

/**
 * Where a session ran, as `manager/repo/leaf`.
 *
 * Truncated paths were the worst column in the listing: every worktree rendered as
 * `…ktrees/arch/married-plane`, with the useful part — which tool made it, and from what — cut
 * off the front. Three facts tell one row from another: which tool made the worktree, which
 * repository it came from, and what it is called. A checkout has no manager, so it reads
 * `/arch/(parent)` — the empty leading segment is the absence, not a path.
 */

/** `~/.t3/worktrees/arch/t3code-e204` -> t3/arch/t3code-e204 */
const MANAGED = /(?:^|\/)\.([A-Za-z0-9_-]+)\/worktrees\/([^/]+)\/([^/]+)/;
/** `~/code/arch.worktrees/agent-a01` -> claude/arch/agent-a01 */
const BESIDE = /(?:^|\/)([^/]+)\.worktrees\/([^/]+)/;

export interface Location {
  /** Whatever made the worktree: t3, superset, claude. Null for a plain checkout. */
  readonly manager: string | null;
  readonly repo: string;
  /** The worktree's name, or "parent" for the checkout itself. */
  readonly leaf: string;
}

export function describeLocation(cwd: string | null, projectRoot: string | null): Location | null {
  if (!cwd) return null;

  const managed = MANAGED.exec(cwd);
  if (managed) return { manager: managed[1]!, repo: managed[2]!, leaf: managed[3]! };

  const beside = BESIDE.exec(cwd);
  if (beside) return { manager: "claude", repo: basename(beside[1]!), leaf: beside[2]! };

  const root = projectRoot ?? cwd;
  if (cwd === root) return { manager: null, repo: basename(root) || root, leaf: "(parent)" };

  // Inside the checkout: name the part below it, which is what tells two rows apart.
  const below = cwd.startsWith(root + sep) ? cwd.slice(root.length + 1) : null;
  return { manager: null, repo: basename(root) || root, leaf: below ?? tildify(cwd) };
}

export function formatLocation(location: Location | null, width?: number): string {
  if (!location) return "NA";
  const head = `${location.manager ?? ""}/${location.repo}`;
  if (width === undefined) return `${head}/${location.leaf}`;

  // Shorten the worktree's name rather than the front: which tool and which repository are what
  // separate one row from the next, and they sit at the front.
  const room = width - head.length - 1;
  if (room >= location.leaf.length) return `${head}/${location.leaf}`;
  if (room < 4) return head.slice(0, width);
  return `${head}/${location.leaf.slice(0, room - 1)}…`;
}
