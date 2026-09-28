import type { Database } from "bun:sqlite";
import { importedThreadId, CLAUDE_INSTANCE } from "./commands.ts";

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

/** Claude sessions T3 started itself — never re-import one of these. */
export function nativeSessionIds(db: Database): Set<string> {
  const rows = db
    .query<{ resume_cursor_json: string | null }, [string]>(
      "SELECT resume_cursor_json FROM provider_session_runtime WHERE provider_name = ?",
    )
    .all(CLAUDE_INSTANCE);
  const ids = new Set<string>();
  for (const row of rows) {
    const resume = asObject(row.resume_cursor_json).resume;
    if (typeof resume === "string") ids.add(resume);
  }
  return ids;
}

/**
 * Sessions already imported, read straight off the event log.
 *
 * The deterministic thread id makes this a prefix scan — no bookkeeping table, and it sees
 * imports made by T3 itself as well as by this tool.
 */
export function importedSessionIds(db: Database): Set<string> {
  const prefix = importedThreadId("");
  const rows = db
    .query<{ stream_id: string }, [string]>(
      "SELECT DISTINCT stream_id FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id GLOB ?",
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
