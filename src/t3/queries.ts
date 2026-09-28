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
 * Sessions T3 started itself — never re-import one of these.
 *
 * Import bindings are excluded: they outlive the threads they belonged to, and counting them
 * would permanently mark every undone session as "started by T3".
 */
export function nativeSessionIds(db: Database, provider: Provider): Set<string> {
  const rows = db
    .query<{ resume_cursor_json: string | null }, [string]>(
      "SELECT resume_cursor_json FROM provider_session_runtime " +
        "WHERE provider_name = ? AND thread_id NOT GLOB 'import:*'",
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
