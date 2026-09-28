import type { Database } from "bun:sqlite";
import { nowIso } from "../time.ts";
import { threadDelete } from "../t3/commands.ts";
import { EventLog } from "../t3/eventlog.ts";
import { liveImportedThreads, type ImportedThread } from "../t3/queries.ts";

/**
 * Remove threads this tool imported, the way T3 removes a thread itself.
 *
 * Deleting rows from the event log would be wrong twice over: projections are checkpointed and
 * would survive the deletion, and an event store is append-only by design. Appending
 * thread.deleted lets T3 project the removal on its next start.
 */
export function removable(db: Database, workspaceRoot?: string): ImportedThread[] {
  const threads = liveImportedThreads(db);
  return workspaceRoot === undefined
    ? threads
    : threads.filter((thread) => thread.workspaceRoot === workspaceRoot);
}

export function remove(db: Database, threads: readonly ImportedThread[], now = nowIso()): number {
  const log = new EventLog(db);
  db.transaction(() => {
    for (const thread of threads) log.append(threadDelete(thread.threadId, now));
  })();
  return threads.length;
}
