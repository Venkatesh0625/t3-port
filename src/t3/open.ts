import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Config } from "../config.ts";
import { PortError } from "../errors.ts";
import { liveServer } from "../proc.ts";
import { checkCompatibility, type Compatibility } from "./schema.ts";

export interface OpenOptions {
  readonly write: boolean;
  /** Proceed even when the write surface has drifted. */
  readonly force?: boolean;
}

export interface OpenResult {
  readonly db: Database;
  readonly compatibility: Compatibility;
}

export function open(config: Config, options: OpenOptions): OpenResult {
  if (!existsSync(config.db)) throw new PortError(`${config.db} not found`);

  if (options.write) {
    const server = liveServer(config.runtimeFile);
    if (server) {
      throw new PortError(
        `T3 Code is running (pid ${server.pid}). Quit it first — it only reads new events at startup.`,
      );
    }
  }

  const db = new Database(config.db, options.write ? { readwrite: true } : { readonly: true });
  const compatibility = checkCompatibility(db);

  if (options.write && !compatibility.compatible && !options.force) {
    db.close();
    const changed = compatibility.drift.map((d) => d.table).join(", ");
    throw new PortError(
      `T3's schema has changed in tables this tool writes: ${changed}. ` +
        `Event shapes were verified against ${compatibility.migrationId ?? "?"}; re-verify before writing. ` +
        `Pass --force to write anyway (a backup is still taken).`,
    );
  }
  return { db, compatibility };
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/**
 * A consistent copy beside the original.
 *
 * `VACUUM INTO` is the right primitive here: it reads through WAL, so the copy reflects
 * committed state, and it writes a single self-contained file. Copying state.sqlite alone
 * would miss everything still in the -wal.
 */
export function backup(db: Database, dbPath: string, now = new Date()): string {
  const dest = join(dirname(dbPath), `${basename(dbPath)}.t3p-${stamp(now)}.bak`);
  db.run(`VACUUM INTO ${escapeLiteral(dest)}`);
  return dest;
}

function escapeLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
