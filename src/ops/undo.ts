import type { Database } from "bun:sqlite";
import { nowIso } from "../time.ts";
import { EventLog } from "../t3/eventlog.ts";

/**
 * Remove threads this tool imported, the way T3 removes a thread itself.
 *
 * Deleting rows out of the event log would be wrong twice over: projections are checkpointed,
 * so they would survive the deletion, and an event store is append-only by design. Appending
 * thread.deleted (decider.ts "thread.delete") lets T3 project the removal on its next start.
 */

export interface Removable {
  readonly threadId: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly sessionId: string | null;
}

/** Imported threads that are still live, optionally narrowed to one project root. */
export function removable(db: Database, workspaceRoot?: string): Removable[] {
  const rows = db
    .query<
      { thread_id: string; title: string; workspace_root: string; resume_cursor_json: string | null },
      []
    >(
      `SELECT t.thread_id, t.title, p.workspace_root, r.resume_cursor_json
         FROM projection_threads t
         JOIN projection_projects p ON p.project_id = t.project_id
         LEFT JOIN provider_session_runtime r ON r.thread_id = t.thread_id
        WHERE t.thread_id GLOB 'import:*' AND t.deleted_at IS NULL
        ORDER BY t.updated_at DESC`,
    )
    .all();

  return rows
    .filter((r) => workspaceRoot === undefined || r.workspace_root === workspaceRoot)
    .map((r) => {
      let sessionId: string | null = null;
      try {
        const resume = JSON.parse(r.resume_cursor_json ?? "{}").resume;
        if (typeof resume === "string") sessionId = resume;
      } catch {
        // a binding we cannot read still deletes fine
      }
      return {
        threadId: r.thread_id,
        title: r.title,
        workspaceRoot: r.workspace_root,
        sessionId,
      };
    });
}

export function remove(db: Database, threads: readonly Removable[], now = nowIso()): number {
  const log = new EventLog(db);
  db.transaction(() => {
    for (const thread of threads) {
      log.append({
        aggregateKind: "thread",
        streamId: thread.threadId,
        events: [
          {
            type: "thread.deleted",
            occurredAt: now,
            payload: { threadId: thread.threadId, deletedAt: now },
          },
        ],
      });
    }
  })();
  return threads.length;
}
