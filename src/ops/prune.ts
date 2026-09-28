import type { Database } from "bun:sqlite";
import { statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config.ts";
import type { Session } from "../session.ts";

/**
 * Redundant copies of a transcript.
 *
 * Claude stores a transcript under the directory it ran in, and copies it to the project root
 * when a session ran in a worktree — so nearly half of a transcript directory can be second
 * copies. Locally: 1.04 GB across 434 files for 225 sessions, 0.49 GB of it duplicated.
 *
 * Only a copy nothing can reach is removable. `claude --resume` finds a transcript by the
 * directory it is run from, so a copy sitting in the slug of a directory that still exists is
 * still reachable and stays. That halves the saving and is the difference between reclaiming
 * space and losing the ability to resume.
 */

const slug = (path: string): string => path.replace(/[^A-Za-z0-9]/g, "-");

export interface Redundant {
  readonly path: string;
  readonly bytes: number;
  readonly sessionId: string;
  /** The copy that is being kept instead. */
  readonly keeping: string;
}

/**
 * Directories a T3 thread would resume a session from.
 *
 * Not the `filePath` a thread records: that is provenance, noting which copy was read at import
 * time, and on this machine 102 of 210 of them point at a worktree copy — exactly the copies
 * worth removing. What resume actually needs is a transcript in the slug of the directory the
 * thread runs in, so that is what must survive.
 */
function resumeDirs(db: Database, config: Config): Set<string> {
  const dirs = new Set<string>();
  for (const row of db
    .query<{ runtime_payload_json: string | null }, []>(
      "SELECT runtime_payload_json FROM provider_session_runtime WHERE runtime_payload_json IS NOT NULL",
    )
    .all()) {
    try {
      const cwd = JSON.parse(row.runtime_payload_json ?? "{}").cwd;
      if (typeof cwd === "string" && cwd) dirs.add(join(config.claudeProjects, slug(cwd)));
    } catch {
      continue;
    }
  }
  return dirs;
}

/**
 * Whether a directory of copies can still be resumed from.
 *
 * The slug is lossy — every non-alphanumeric character became the same dash — so it cannot be
 * reversed, and guessing at it only ever produces a path that does not exist, which would mark
 * every copy removable. Instead each session names the directory it ran in, which gives the one
 * mapping that matters: slug(cwd) -> cwd. A directory we cannot map stays, because being unable
 * to tell is a reason to keep a file, not to delete it.
 */
function reachableDirs(config: Config, sessions: readonly Session[], exists: (dir: string) => boolean): {
  known: Set<string>;
  gone: Set<string>;
} {
  const known = new Set<string>();
  const gone = new Set<string>();
  for (const session of sessions) {
    if (!session.cwd) continue;
    const dir = join(config.claudeProjects, slug(session.cwd));
    (exists(session.cwd) ? known : gone).add(dir);
  }
  return { known, gone };
}

export function findRedundant(
  db: Database,
  config: Config,
  sessions: readonly Session[],
  copiesOf: (sessionId: string) => string[],
  exists: (dir: string) => boolean,
  sizeOf: (path: string) => number = (path) => statSync(path).size,
): Redundant[] {
  const { gone } = reachableDirs(config, sessions, exists);
  const protectedDirs = resumeDirs(db, config);
  const redundant: Redundant[] = [];

  for (const session of sessions) {
    if (session.provider !== "claudeAgent") continue;
    const copies = copiesOf(session.sessionId);
    if (copies.length < 2) continue;

    // Keep a copy something can still reach. The directory a session ran in is the natural
    // home, but for a worktree that directory is usually gone — keeping that copy and removing
    // the one at the project root would delete the only reachable transcript.
    const biggest = (paths: readonly string[]): string =>
      paths.reduce((big, path) => (sizeOf(path) > sizeOf(big) ? path : big));
    const reachable = copies.filter((path) => !gone.has(dirname(path)) || protectedDirs.has(dirname(path)));
    const keeper = reachable.length > 0 ? biggest(reachable) : biggest(copies);

    for (const path of copies) {
      if (path === keeper) continue;
      // Only a copy whose directory we can positively place, and whose directory is gone.
      if (!gone.has(dirname(path))) continue;
      // A thread resumes from this directory, so its transcript stays whatever else is true.
      if (protectedDirs.has(dirname(path))) continue;
      redundant.push({
        path,
        bytes: sizeOf(path),
        sessionId: session.sessionId,
        keeping: keeper,
      });
    }
  }
  return redundant;
}


export function remove(entries: readonly Redundant[]): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    try {
      unlinkSync(entry.path);
      files += 1;
      bytes += entry.bytes;
    } catch {
      // A file that vanished underneath us needed no removing.
    }
  }
  return { files, bytes };
}
