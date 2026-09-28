import type { Database } from "bun:sqlite";

/**
 * An import run, recovered from the correlation id its events share.
 *
 * Whether T3 has folded a run into its projections decides how it can be undone. The projection
 * cursor only moves forward, so a run entirely above it has never been seen: its events can be
 * removed outright, leaving the database as though the import never ran. Once T3 has projected
 * them, removing the events would strand the projection rows they produced, and the only honest
 * reversal is a compensating deletion.
 */
export interface Run {
  readonly id: string;
  readonly threads: number;
  readonly events: number;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly at: string;
  /** Threads still live; a run already undone has none. */
  readonly live: number;
  readonly projected: boolean;
}

/** The furthest any projector has advanced. */
export function projectionCursor(db: Database): number {
  const row = db
    .query<{ cursor: number | null }, []>(
      "SELECT MAX(last_applied_sequence) AS cursor FROM projection_state",
    )
    .get();
  return row?.cursor ?? 0;
}

export function runs(db: Database): Run[] {
  const cursor = projectionCursor(db);
  return db
    .query<
      {
        run_id: string;
        threads: number;
        events: number;
        first_sequence: number;
        last_sequence: number;
        at: string;
        live: number;
      },
      []
    >(
      `SELECT e.correlation_id AS run_id,
              COUNT(DISTINCT CASE WHEN e.event_type = 'thread.created' THEN e.stream_id END) AS threads,
              COUNT(*) AS events,
              MIN(e.sequence) AS first_sequence,
              MAX(e.sequence) AS last_sequence,
              MIN(e.occurred_at) AS at,
              COUNT(DISTINCT CASE
                WHEN e.event_type = 'thread.created'
                 AND e.stream_id NOT IN (
                   SELECT stream_id FROM orchestration_events WHERE event_type = 'thread.deleted'
                 )
                THEN e.stream_id END) AS live
         FROM orchestration_events e
        WHERE e.correlation_id IN (
                SELECT correlation_id FROM orchestration_events
                 WHERE stream_id GLOB 'import:*' AND correlation_id IS NOT NULL
              )
        GROUP BY e.correlation_id
        ORDER BY MAX(e.sequence) DESC`,
    )
    .all()
    .map((r) => ({
      id: r.run_id,
      threads: r.threads,
      events: r.events,
      firstSequence: r.first_sequence,
      lastSequence: r.last_sequence,
      at: r.at,
      live: r.live,
      projected: cursor >= r.first_sequence,
    }));
}

/** The most recent run that still has threads to remove. */
export function latestUndoable(db: Database): Run | null {
  return runs(db).find((run) => run.live > 0) ?? null;
}

export function find(db: Database, id: string): Run | null {
  const all = runs(db);
  return all.find((run) => run.id === id) ?? all.find((run) => run.id.startsWith(id)) ?? null;
}
