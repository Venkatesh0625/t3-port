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

/**
 * Imported threads that are still live, optionally narrowed to one project root.
 *
 * Read from the event log rather than the projections. Projections only advance when T3 starts,
 * so a thread imported since its last run is invisible there — undo would report nothing to do
 * immediately after an import, and a second undo before a restart would re-delete what the
 * first already handled. The log is current by construction.
 */
export function removable(db: Database, workspaceRoot?: string): Removable[] {
  const rows = db
    .query<
      { stream_id: string; payload_json: string; workspace_root: string | null; resume_cursor_json: string | null },
      []
    >(
      `SELECT e.stream_id, e.payload_json, p.workspace_root, r.resume_cursor_json
         FROM orchestration_events e
         LEFT JOIN projection_projects p
           ON p.project_id = json_extract(e.payload_json, '$.projectId')
         LEFT JOIN provider_session_runtime r ON r.thread_id = e.stream_id
        WHERE e.aggregate_kind = 'thread'
          AND e.event_type = 'thread.created'
          AND e.stream_id GLOB 'import:*'
          AND e.stream_id NOT IN (
            SELECT stream_id FROM orchestration_events WHERE event_type = 'thread.deleted'
          )
        ORDER BY e.sequence DESC`,
    )
    .all();

  return rows
    .map((r) => {
      let title = r.stream_id;
      try {
        const payload = JSON.parse(r.payload_json);
        if (typeof payload.title === "string") title = payload.title;
      } catch {
        // a thread we cannot read a title for still deletes fine
      }
      let sessionId: string | null = null;
      try {
        const cursor = JSON.parse(r.resume_cursor_json ?? "{}");
        const id = r.stream_id.startsWith("import:codex:") ? cursor.threadId : cursor.resume;
        if (typeof id === "string") sessionId = id;
      } catch {
        // likewise
      }
      return {
        threadId: r.stream_id,
        title,
        workspaceRoot: r.workspace_root ?? "",
        sessionId,
      };
    })
    .filter((t) => workspaceRoot === undefined || t.workspaceRoot === workspaceRoot);
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
