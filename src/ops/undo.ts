import type { Database } from "bun:sqlite";
import { nowIso } from "../time.ts";
import { threadDelete } from "../t3/commands.ts";
import { EventLog } from "../t3/eventlog.ts";
import { liveImportedThreads, type ImportedThread } from "../t3/queries.ts";
import type { Run } from "../t3/runs.ts";

/**
 * Undo an import run.
 *
 * Which reversal is available depends on whether T3 has folded the run into its projections.
 * Before that it can be lifted out whole; afterwards only a compensating deletion is honest.
 */
export type Reversal = "removed" | "deleted";

export interface UndoResult {
  readonly reversal: Reversal;
  readonly threads: number;
  readonly events: number;
}

export function threadsOf(db: Database, run: Run): ImportedThread[] {
  const ids = new Set(
    db
      .query<{ stream_id: string }, [string]>(
        "SELECT DISTINCT stream_id FROM orchestration_events " +
          "WHERE correlation_id = ? AND event_type = 'thread.created'",
      )
      .all(run.id)
      .map((r) => r.stream_id),
  );
  return liveImportedThreads(db).filter((thread) => ids.has(thread.threadId));
}

/**
 * Lift an unprojected run out of the database.
 *
 * Its events were never read by T3, so removing them — with their receipts, their session
 * bindings, and any project the run created and nothing else uses — leaves no trace and frees
 * the thread ids, which is what lets those sessions be imported again.
 */
function removeRun(db: Database, run: Run): UndoResult {
  let events = 0;
  let threads = 0;
  db.transaction(() => {
    threads = db
      .query<{ stream_id: string }, [string]>(
        "SELECT DISTINCT stream_id FROM orchestration_events " +
          "WHERE correlation_id = ? AND event_type = 'thread.created'",
      )
      .all(run.id).length;

    db.run(
      "DELETE FROM provider_session_runtime WHERE thread_id IN " +
        "(SELECT DISTINCT stream_id FROM orchestration_events WHERE correlation_id = ? AND aggregate_kind = 'thread')",
      [run.id],
    );
    // A project the run created is only removed when nothing outside the run refers to it.
    db.run(
      `DELETE FROM projection_projects WHERE project_id IN (
         SELECT DISTINCT stream_id FROM orchestration_events
          WHERE correlation_id = ? AND event_type = 'project.created'
            AND stream_id NOT IN (
              SELECT json_extract(payload_json, '$.projectId') FROM orchestration_events
               WHERE event_type = 'thread.created' AND correlation_id <> ?
            )
       )`,
      [run.id, run.id],
    );
    db.run("DELETE FROM orchestration_command_receipts WHERE command_id IN " +
      "(SELECT DISTINCT command_id FROM orchestration_events WHERE correlation_id = ?)", [run.id]);
    events = db.query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM orchestration_events WHERE correlation_id = ?",
    ).get(run.id)!.n;
    db.run("DELETE FROM orchestration_events WHERE correlation_id = ?", [run.id]);
  })();
  return { reversal: "removed", threads, events };
}

/** Delete a projected run's threads the way T3 deletes a thread. */
function deleteThreads(db: Database, threads: readonly ImportedThread[], now: string): UndoResult {
  const log = new EventLog(db);
  db.transaction(() => {
    for (const thread of threads) log.append(threadDelete(thread.threadId, now));
  })();
  return { reversal: "deleted", threads: threads.length, events: threads.length };
}

export function undoRun(db: Database, run: Run, now = nowIso()): UndoResult {
  return run.projected ? deleteThreads(db, threadsOf(db, run), now) : removeRun(db, run);
}
