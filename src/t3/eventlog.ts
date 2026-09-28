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

/**
 * Every event one run writes carries the same correlation id.
 *
 * T3 fills that column with the command id and never reads it back — it is provenance only.
 * Using it to mark a run means a run can be found again later without adding a table of our own
 * or putting unknown keys in T3's event metadata, which is a closed schema.
 */
export class EventLog {
  constructor(
    private readonly db: Database,
    private readonly runId: string = randomUUID(),
  ) {}

  /** The id tying this run's events together. */
  get run(): string {
    return this.runId;
  }

  private nextVersion(aggregateKind: string, streamId: string): number {
    const row = this.db
      .query<{ next: number }, [string, string]>(
        "SELECT COALESCE(MAX(stream_version) + 1, 0) AS next FROM orchestration_events " +
          "WHERE aggregate_kind = ? AND stream_id = ?",
      )
      .get(aggregateKind, streamId);
    return row?.next ?? 0;
  }

  /** Whether any event has ever been written for this aggregate. */
  exists(aggregateKind: string, streamId: string): boolean {
    const row = this.db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM orchestration_events WHERE aggregate_kind = ? AND stream_id = ?",
      )
      .get(aggregateKind, streamId);
    return (row?.n ?? 0) > 0;
  }

  append(command: Command): void {
    if (command.events.length === 0) return;
    // An aggregate is created once. Appending a second creation — which a re-import into a
    // deterministic thread id would do — leaves a stream T3 cannot fold into one thread.
    if (command.events[0]!.type.endsWith(".created") && this.exists(command.aggregateKind, command.streamId)) {
      throw new Error(
        `Refusing to recreate ${command.aggregateKind} '${command.streamId}': its stream already has events.`,
      );
    }
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
        this.runId,
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
