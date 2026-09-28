import type { Database } from "bun:sqlite";
import { importedThreadId, CLAUDE_INSTANCE, CODEX_INSTANCE } from "./commands.ts";

export interface Project {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface ThreadRow {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly provider: string | null;
  readonly resumeSessionId: string | null;
  readonly runtimeCwd: string | null;
  readonly importedFrom: string | null;
  readonly updatedAt: string;
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
 * The cursor shape is provider-specific: Claude stores the session under `resume`, Codex stores
 * it as the cursor's own `threadId`.
 */
export function nativeSessionIds(db: Database, provider: string = CLAUDE_INSTANCE): Set<string> {
  const rows = db
    .query<{ resume_cursor_json: string | null }, [string]>(
      // An import's binding survives its thread's deletion. Counting those as native would
      // permanently mark every undone session as "started by T3" and block re-importing it.
      "SELECT resume_cursor_json FROM provider_session_runtime " +
        "WHERE provider_name = ? AND thread_id NOT GLOB 'import:*'",
    )
    .all(provider);
  const ids = new Set<string>();
  for (const row of rows) {
    const cursor = asObject(row.resume_cursor_json);
    const id = provider === CODEX_INSTANCE ? cursor.threadId : cursor.resume;
    if (typeof id === "string") ids.add(id);
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
 * the stream the first one already used, giving one aggregate two creation events. Undo is
 * therefore final for a session: it frees the conversation, not the id.
 */
export function importedSessionIds(db: Database, provider: string = CLAUDE_INSTANCE): Set<string> {
  const prefix = importedThreadId("", provider);
  const rows = db
    .query<{ stream_id: string }, [string]>(
      "SELECT DISTINCT stream_id FROM orchestration_events " +
        "WHERE aggregate_kind = 'thread' AND stream_id GLOB ?",
    )
    .all(`${prefix}*`);
  return new Set(rows.map((r) => r.stream_id.slice(prefix.length)));
}

export function threads(db: Database): ThreadRow[] {
  return db
    .query<
      {
        thread_id: string;
        title: string;
        workspace_root: string;
        provider_name: string | null;
        resume_cursor_json: string | null;
        runtime_payload_json: string | null;
        updated_at: string;
      },
      []
    >(
      `SELECT t.thread_id, t.title, p.workspace_root, r.provider_name,
              r.resume_cursor_json, r.runtime_payload_json, t.updated_at
         FROM projection_threads t
         JOIN projection_projects p ON p.project_id = t.project_id
         LEFT JOIN provider_session_runtime r ON r.thread_id = t.thread_id
        WHERE t.deleted_at IS NULL
        ORDER BY t.updated_at DESC, t.thread_id`,
    )
    .all()
    .map((r) => {
      const payload = asObject(r.runtime_payload_json);
      const imported = Array.isArray(payload.importedTranscripts) ? payload.importedTranscripts[0] : null;
      const resume = asObject(r.resume_cursor_json).resume;
      return {
        id: r.thread_id,
        title: r.title,
        workspaceRoot: r.workspace_root,
        provider: r.provider_name,
        resumeSessionId: typeof resume === "string" ? resume : null,
        runtimeCwd: typeof payload.cwd === "string" ? payload.cwd : null,
        importedFrom:
          imported && typeof imported === "object" && typeof (imported as any).filePath === "string"
            ? (imported as any).filePath
            : null,
        updatedAt: r.updated_at,
      };
    });
}
