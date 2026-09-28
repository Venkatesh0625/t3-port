import type { Database } from "bun:sqlite";

/**
 * Compatibility is decided by the shape of what we write, not by the migration counter.
 *
 * T3's migration id rises for changes that have nothing to do with this tool: 53
 * (PullRequestFilesViewed) and 54 (ProjectionThreadsAutoSettleDisabledAt) both bumped it
 * without touching a table we write. Gating on the number blocks harmless updates and still
 * says nothing about whether our writes are safe. Gating on the DDL of the tables we touch
 * answers the question directly.
 */

/** Tables this tool writes to or reads structurally. */
export const WRITE_SURFACE = [
  "orchestration_events",
  "orchestration_command_receipts",
  "provider_session_runtime",
  "projection_projects",
  "projection_threads",
  "projection_thread_messages",
] as const;

export type SurfaceTable = (typeof WRITE_SURFACE)[number];

function normalizeDdl(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function digest(sql: string): string {
  return new Bun.CryptoHasher("sha256").update(normalizeDdl(sql)).digest("hex").slice(0, 16);
}

export function migrationId(db: Database): number | null {
  const row = db.query<{ id: number | null }, []>("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get();
  return row?.id ?? null;
}

export function migrationsSince(db: Database, id: number): Array<{ id: number; name: string }> {
  return db
    .query<{ id: number; name: string }, [number]>(
      "SELECT migration_id AS id, name FROM effect_sql_migrations WHERE migration_id > ? ORDER BY migration_id",
    )
    .all(id);
}

/** A stable hash per table we depend on. */
export function fingerprint(db: Database): Record<string, string | null> {
  const stmt = db.query<{ sql: string | null }, [string]>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  );
  const out: Record<string, string | null> = {};
  for (const table of WRITE_SURFACE) {
    const sql = stmt.get(table)?.sql;
    out[table] = sql ? digest(sql) : null;
  }
  return out;
}

/** Captured from T3 Code 0.0.43-nightly.20260928.2375, schema migration 54. */
export const BASELINE = {
  migrationId: 54,
  version: "0.0.43-nightly.20260928.2375",
  tables: {
    orchestration_events: "ca00926a98feecae",
    orchestration_command_receipts: "150b52b9029a2c65",
    provider_session_runtime: "69503fc6a6f12d6e",
    projection_projects: "ff37f90fc4e0c251",
    projection_threads: "bd68497bf6fbe059",
    projection_thread_messages: "239b45875565914e",
  } as Record<string, string>,
};

export interface Drift {
  readonly table: string;
  readonly expected: string;
  readonly actual: string | null;
}

export interface Compatibility {
  readonly compatible: boolean;
  readonly drift: readonly Drift[];
  readonly migrationId: number | null;
  readonly newMigrations: ReadonlyArray<{ id: number; name: string }>;
}

export function checkCompatibility(db: Database): Compatibility {
  const actual = fingerprint(db);
  const drift: Drift[] = [];
  for (const [table, expected] of Object.entries(BASELINE.tables)) {
    if (actual[table] !== expected) {
      drift.push({ table, expected, actual: actual[table] ?? null });
    }
  }
  const id = migrationId(db);
  return {
    compatible: drift.length === 0,
    drift,
    migrationId: id,
    newMigrations: id !== null && id > BASELINE.migrationId ? migrationsSince(db, BASELINE.migrationId) : [],
  };
}
