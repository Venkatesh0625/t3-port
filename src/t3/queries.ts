import type { Database } from "bun:sqlite";
import { PROVIDERS, type Provider } from "../providers/index.ts";
import { importedThreadId } from "./commands.ts";

export interface Project {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

function asObject(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function projects(db: Database): Project[] {
  return db
    .query<{ project_id: string; title: string; workspace_root: string }, []>(
      "SELECT project_id, title, workspace_root FROM projection_projects WHERE deleted_at IS NULL",
    )
    .all()
    .map((r) => ({ id: r.project_id, title: r.title, workspaceRoot: r.workspace_root }));
}

/**
 * Sessions a live T3 thread already resumes — never import one of these, or two threads would
 * write to one transcript.
 *
 * A binding outlives its thread: T3 deletes a thread and leaves the row, and on one machine 31
 * of 42 of them belonged to threads that no longer exist. Counting those marks a conversation
 * "started by T3" for good, while T3 shows it nowhere at all. Existence is decided from the
 * event log rather than the projections, which only advance when T3 starts.
 *
 * Import bindings are excluded for the same reason from the other direction: they outlive an
 * undone import, and counting them would make every undone session permanently native.
 */
export function nativeSessionIds(db: Database, provider: Provider): Set<string> {
  const rows = db
    .query<{ resume_cursor_json: string | null }, [string]>(
      `SELECT r.resume_cursor_json
         FROM provider_session_runtime r
        WHERE r.provider_name = ?
          AND r.thread_id NOT GLOB 'import:*'
          AND EXISTS (
            SELECT 1 FROM orchestration_events e
             WHERE e.stream_id = r.thread_id AND e.event_type = 'thread.created'
          )
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_events e
             WHERE e.stream_id = r.thread_id AND e.event_type = 'thread.deleted'
          )`,
    )
    .all(provider.id);
  const ids = new Set<string>();
  for (const row of rows) {
    const id = provider.sessionIdFromCursor(asObject(row.resume_cursor_json));
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Sessions already imported, read straight off the event log.
 *
 * The deterministic thread id makes this a prefix scan — no bookkeeping table, and it sees
 * imports made by T3 itself as well as by this tool.
 *
 * Deleted threads still count. The id is derived from the session, so a re-import would land in
 * the stream the first one used, giving one aggregate two creation events. Undo is final for a
 * session: it frees the conversation, not the id.
 */
export function importedSessionIds(db: Database, provider: Provider): Set<string> {
  const prefix = importedThreadId("", provider.id);
  const rows = db
    .query<{ stream_id: string }, [string]>(
      "SELECT DISTINCT stream_id FROM orchestration_events " +
        "WHERE aggregate_kind = 'thread' AND stream_id GLOB ?",
    )
    .all(`${prefix}*`);
  return new Set(rows.map((r) => r.stream_id.slice(prefix.length)));
}

export interface ImportedThread {
  readonly threadId: string;
  readonly providerId: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly sessionId: string | null;
}

/**
 * Imported threads that have not been deleted, read from the event log.
 *
 * Projections only advance when T3 starts, so a thread imported since its last run is invisible
 * there. The log is current by construction.
 */
export function liveImportedThreads(db: Database): ImportedThread[] {
  const rows = db
    .query<
      {
        stream_id: string;
        payload_json: string;
        workspace_root: string | null;
        resume_cursor_json: string | null;
      },
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

  return rows.map((r) => {
    // The thread id is import:<providerInstanceId>:<sessionId>, so the provider names itself.
    const providerId = r.stream_id.split(":")[1] ?? "";
    const provider = PROVIDERS.find((candidate) => candidate.id === providerId);
    const payload = asObject(r.payload_json);
    return {
      threadId: r.stream_id,
      providerId,
      title: typeof payload.title === "string" ? payload.title : r.stream_id,
      workspaceRoot: r.workspace_root ?? "",
      sessionId: provider?.sessionIdFromCursor(asObject(r.resume_cursor_json)) ?? null,
    };
  });
}

export interface Owner {
  readonly threadId: string;
  readonly title: string;
  /** Archived threads still resume their session but do not appear in the thread list. */
  readonly archived: boolean;
}

/**
 * The thread that already holds each session, whether T3 opened it or an import brought it in.
 *
 * "Skipped: started by T3" answers the wrong question. The conversation is not missing; it is
 * somewhere, and saying where turns a refusal into a direction.
 */
export function ownersBySession(db: Database): Map<string, Owner> {
  const owners = new Map<string, Owner>();
  for (const row of db
    .query<
      {
        thread_id: string;
        title: string | null;
        archived: number;
        resume_cursor_json: string | null;
      },
      []
    >(
      // The title comes from the projection when there is one and from the creation event
      // otherwise: a thread imported since T3 last started has no projection row yet, and
      // answering with a raw thread id tells the reader nothing.
      `SELECT r.thread_id,
              COALESCE(t.title, json_extract(e.payload_json, '$.title')) AS title,
              EXISTS (
                SELECT 1 FROM orchestration_events a
                 WHERE a.stream_id = r.thread_id AND a.event_type = 'thread.archived'
              ) AS archived,
              r.resume_cursor_json
         FROM provider_session_runtime r
         LEFT JOIN projection_threads t ON t.thread_id = r.thread_id AND t.deleted_at IS NULL
         LEFT JOIN orchestration_events e
           ON e.stream_id = r.thread_id AND e.event_type = 'thread.created'
        WHERE r.resume_cursor_json IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_events d
             WHERE d.stream_id = r.thread_id AND d.event_type = 'thread.deleted'
          )`,
    )
    .all()) {
    const cursor = asObject(row.resume_cursor_json);
    for (const provider of PROVIDERS) {
      const sessionId = provider.sessionIdFromCursor(cursor);
      if (sessionId) {
        owners.set(sessionId, {
          threadId: row.thread_id,
          title: row.title ?? "",
          archived: row.archived === 1,
        });
        break;
      }
    }
  }
  return owners;
}
