import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { latest } from "../time.ts";
import type { Command, PlannedEvent } from "./eventlog.ts";

/**
 * Command builders mirroring apps/server/src/orchestration/decider.ts.
 *
 * T3 normally turns a command into events inside its engine. We are writing to a closed
 * database with no engine running, so each builder reproduces one decider branch. Keeping
 * them named after the upstream commands makes the correspondence checkable when T3 changes.
 */

export const CLAUDE_INSTANCE = "claudeAgent";

/** Sessions T3 refuses to resume are not worth importing. (AgentSessionImporter.ts:32) */
export const CLAUDE_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const HISTORY_IMPORT = { historyImport: true } as const;

/** `import:<providerInstanceId>:<providerSessionId>` (AgentSessionImporter.ts:168). */
export function importedThreadId(sessionId: string, instance = CLAUDE_INSTANCE): string {
  return `import:${instance}:${sessionId}`;
}

/** `<threadId>:<index padded to 6>` (AgentSessionImporter.ts:267). */
export function importedMessageId(threadId: string, index: number): string {
  return `${threadId}:${String(index).padStart(6, "0")}`;
}

export interface ImportMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

/** decider.ts "thread.create" */
export function threadCreate(input: {
  threadId: string;
  projectId: string;
  title: string;
  model: string;
  instance?: string;
  createdAt: string;
}): Command {
  const instance = input.instance ?? CLAUDE_INSTANCE;
  return {
    aggregateKind: "thread",
    streamId: input.threadId,
    events: [
      {
        type: "thread.created",
        occurredAt: input.createdAt,
        metadata: HISTORY_IMPORT,
        payload: {
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          modelSelection: { instanceId: instance, model: input.model },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        },
      },
    ],
  };
}

/**
 * decider.ts "thread.history.import" (decider.ts:2003) — one thread.message-sent per message,
 * then a single thread.settled dated to the newest of them.
 */
export function threadHistoryImport(threadId: string, messages: readonly ImportMessage[]): Command {
  const first = messages[0];
  if (!first) throw new Error("Thread history imports require at least one message.");

  const events: PlannedEvent[] = messages.map((message, index) => ({
    type: "thread.message-sent",
    occurredAt: message.createdAt,
    metadata: HISTORY_IMPORT,
    payload: {
      threadId,
      messageId: importedMessageId(threadId, index),
      role: message.role,
      text: message.text,
      turnId: null,
      streaming: false,
      createdAt: message.createdAt,
      updatedAt: message.createdAt,
    },
  }));

  const settledAt = latest(
    messages.map((m) => m.createdAt),
    first.createdAt,
  );
  events.push({
    type: "thread.settled",
    occurredAt: settledAt,
    metadata: HISTORY_IMPORT,
    payload: { threadId, settledAt, updatedAt: settledAt },
  });

  return { aggregateKind: "thread", streamId: threadId, events };
}

/** decider.ts "project.create" */
export function projectCreate(input: { title: string; workspaceRoot: string; now: string }): {
  projectId: string;
  command: Command;
} {
  const projectId = randomUUID();
  return {
    projectId,
    command: {
      aggregateKind: "project",
      streamId: projectId,
      events: [
        {
          type: "project.created",
          occurredAt: input.now,
          payload: {
            projectId,
            title: input.title,
            workspaceRoot: input.workspaceRoot,
            defaultModelSelection: null,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: input.now,
            updatedAt: input.now,
          },
        },
      ],
    },
  };
}

export interface TranscriptSource {
  readonly filePath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly device: number;
  readonly inode: number;
}

/**
 * The resume cursor is what makes an imported thread continue the real Claude session rather
 * than start a new one: the adapter passes `resume` straight to the Agent SDK.
 * Inserted with ON CONFLICT DO NOTHING so a live binding is never displaced
 * (AgentSessionImporter.ts:225 makes the same choice).
 */
export function bindClaudeSession(
  db: Database,
  input: {
    threadId: string;
    sessionId: string;
    cwd: string;
    source: TranscriptSource;
    now: string;
  },
): void {
  db.run(
    `INSERT INTO provider_session_runtime
       (thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status,
        last_seen_at, resume_cursor_json, runtime_payload_json)
     VALUES (?, ?, ?, ?, 'full-access', 'stopped', ?, ?, ?)
     ON CONFLICT (thread_id) DO NOTHING`,
    [
      input.threadId,
      CLAUDE_INSTANCE,
      CLAUDE_INSTANCE,
      CLAUDE_INSTANCE,
      input.now,
      JSON.stringify({ threadId: input.threadId, resume: input.sessionId }),
      JSON.stringify({
        cwd: input.cwd,
        importedTranscripts: [
          {
            provider: CLAUDE_INSTANCE,
            providerInstanceId: CLAUDE_INSTANCE,
            providerSessionId: input.sessionId,
            filePath: input.source.filePath,
            size: input.source.size,
            mtimeMs: input.source.mtimeMs,
            device: input.source.device,
            inode: input.source.inode,
            birthtimeMs: null,
          },
        ],
      }),
    ],
  );
}
