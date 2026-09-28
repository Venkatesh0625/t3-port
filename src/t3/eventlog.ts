import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

/**
 * T3 Code is event sourced: orchestration_events is the log, and every projection_* table is
 * derived from it when the server boots. Writing a projection row directly would be undone on
 * the next rebuild, so everything here appends events and lets T3 project them.
 */

export interface PlannedEvent {
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: unknown;
  readonly metadata?: Record<string, unknown>;
}

/** One command's worth of events, appended under a shared command id like the engine does. */
export interface Command {
  readonly aggregateKind: "thread" | "project";
  readonly streamId: string;
  readonly events: readonly PlannedEvent[];
}

export class EventLog {
  constructor(private readonly db: Database) {}

  private nextVersion(aggregateKind: string, streamId: string): number {
    const row = this.db
      .query<{ next: number }, [string, string]>(
        "SELECT COALESCE(MAX(stream_version) + 1, 0) AS next FROM orchestration_events " +
          "WHERE aggregate_kind = ? AND stream_id = ?",
      )
      .get(aggregateKind, streamId);
    return row?.next ?? 0;
  }

  append(command: Command): void {
    if (command.events.length === 0) return;
    const commandId = randomUUID();
    let version = this.nextVersion(command.aggregateKind, command.streamId);
    let lastSequence = 0;

    const insert = this.db.query<{ sequence: number }, any[]>(
      `INSERT INTO orchestration_events
         (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'client', ?, ?)
       RETURNING sequence`,
    );

    for (const event of command.events) {
      const row = insert.get(
        randomUUID(),
        command.aggregateKind,
        command.streamId,
        version++,
        event.type,
        event.occurredAt,
        commandId,
        commandId,
        JSON.stringify(event.payload),
        JSON.stringify(event.metadata ?? {}),
      );
      lastSequence = row?.sequence ?? lastSequence;
    }

    const last = command.events[command.events.length - 1]!;
    this.db.run(
      "INSERT INTO orchestration_command_receipts VALUES (?, ?, ?, ?, ?, 'accepted', NULL)",
      [commandId, command.aggregateKind, command.streamId, last.occurredAt, lastSequence],
    );
  }
}
