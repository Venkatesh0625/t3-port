import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Provider } from "../providers/index.ts";
import { latest } from "../time.ts";
import type { Command, PlannedEvent } from "./eventlog.ts";

/**
 * Command builders mirroring apps/server/src/orchestration/decider.ts.
 *
 * T3 normally turns a command into events inside its engine. We write to a closed database with
 * no engine running, so each builder reproduces one decider branch. Keeping them named after
 * the upstream commands makes the correspondence checkable when T3 changes.
 */

const HISTORY_IMPORT = { historyImport: true } as const;

/** `import:<providerInstanceId>:<providerSessionId>` (AgentSessionImporter.ts:168). */
export function importedThreadId(sessionId: string, providerId: string): string {
  return `import:${providerId}:${sessionId}`;
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
  providerId: string;
  createdAt: string;
}): Command {
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
          modelSelection: { instanceId: input.providerId, model: input.model },
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
 * then a single thread.settled dated to the newest of them. Backfilling these is what makes an
 * imported conversation visible; the resume cursor alone leaves the thread empty.
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

  const settledAt = latest(messages.map((m) => m.createdAt), first.createdAt);
  events.push({
    type: "thread.settled",
    occurredAt: settledAt,
    metadata: HISTORY_IMPORT,
    payload: { threadId, settledAt, updatedAt: settledAt },
  });

  return { aggregateKind: "thread", streamId: threadId, events };
}

/**
 * decider.ts "thread.unsettle" — bring an imported thread into the active list.
 *
 * A history import always settles: the decider emits thread.settled after the messages, dated
 * to the newest one, because T3 treats imported conversations as history. That is right for a
 * bulk first-run import and wrong for someone bringing a conversation across to carry on with,
 * which lands it in a list they are not looking at.
 *
 * `reason: "user"` sets settledOverride to "active" rather than only clearing the timestamp, so
 * auto-settle does not quietly put it back (ProjectionPipeline.ts:697).
 */
export function threadUnsettle(threadId: string, at: string): Command {
  return {
    aggregateKind: "thread",
    streamId: threadId,
    events: [
      {
        type: "thread.unsettled",
        occurredAt: at,
        payload: { threadId, reason: "user", updatedAt: at },
      },
    ],
  };
}

/** decider.ts "thread.delete" */
export function threadDelete(threadId: string, at: string): Command {
  return {
    aggregateKind: "thread",
    streamId: threadId,
    events: [{ type: "thread.deleted", occurredAt: at, payload: { threadId, deletedAt: at } }],
  };
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
 * Bind a thread to the provider session it resumes.
 *
 * Inserted with ON CONFLICT DO NOTHING so a live binding is never displaced — the same choice
 * AgentSessionImporter.ts:225 makes, for the same reason.
 */
export function bindSession(
  db: Database,
  input: {
    provider: Provider;
    threadId: string;
    sessionId: string;
    cwd: string;
    source: TranscriptSource;
    now: string;
  },
): void {
  const { provider } = input;
  db.run(
    `INSERT INTO provider_session_runtime
       (thread_id, provider_name, provider_instance_id, adapter_key, runtime_mode, status,
        last_seen_at, resume_cursor_json, runtime_payload_json)
     VALUES (?, ?, ?, ?, 'full-access', 'stopped', ?, ?, ?)
     ON CONFLICT (thread_id) DO NOTHING`,
    [
      input.threadId,
      provider.id,
      provider.id,
      provider.id,
      input.now,
      JSON.stringify(provider.resumeCursor(input.threadId, input.sessionId)),
      JSON.stringify({
        cwd: input.cwd,
        importedTranscripts: [
          {
            provider: provider.id,
            providerInstanceId: provider.id,
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
