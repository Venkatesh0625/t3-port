import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Codex thread names.
 *
 * A rollout records the conversation but never its name. The authoritative store is
 * ~/.codex/state_<n>.sqlite, whose `threads` table holds a short `name` alongside a `title` and
 * `preview` that are only the first user message repeated — so `name` is the one worth having.
 * Most threads have none: 18 of 84 locally.
 *
 * Opened with immutable=1 because Codex keeps the database in WAL mode and a plain read-only
 * connection cannot create the shared-memory file while Codex holds it. The cost is not seeing
 * writes still in the WAL, which for a thread name is not worth a second thought.
 */

const cache = new Map<string, ReadonlyMap<string, string>>();

/** The highest-numbered state database, since Codex versions the filename. */
function newestStateDb(codexHome: string): string | null {
  if (!existsSync(codexHome)) return null;
  const candidates = readdirSync(codexHome)
    .map((file) => ({ file, n: /^state_(\d+)\.sqlite$/.exec(file) }))
    .flatMap(({ file, n }) => (n ? [{ file, n: Number(n[1]) }] : []))
    .sort((a, b) => b.n - a.n);
  return candidates[0] ? join(codexHome, candidates[0].file) : null;
}

function fromStateDb(path: string): Map<string, string> | null {
  try {
    const db = new Database(`file:${path}?immutable=1`, { readonly: true });
    try {
      const rows = db
        .query<{ id: string; name: string | null }, []>(
          "SELECT id, name FROM threads WHERE name IS NOT NULL AND name <> ''",
        )
        .all();
      const named = new Map<string, string>();
      for (const row of rows) {
        const name = row.name?.trim();
        if (name) named.set(row.id, name);
      }
      return named;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Older layouts kept the same names in a JSONL sidecar. */
function fromIndexFile(codexHome: string): Map<string, string> {
  const names = new Map<string, string>();
  const path = join(codexHome, "session_index.jsonl");
  if (!existsSync(path)) return names;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const id = typeof entry?.id === "string" ? entry.id : null;
      const name = typeof entry?.thread_name === "string" ? entry.thread_name.trim() : "";
      // Later lines win: the file is appended to as threads are named.
      if (id && name) names.set(id, name);
    } catch {
      continue;
    }
  }
  return names;
}

export function threadNames(codexHome: string): ReadonlyMap<string, string> {
  const cached = cache.get(codexHome);
  if (cached) return cached;

  const stateDb = newestStateDb(codexHome);
  const names = (stateDb === null ? null : fromStateDb(stateDb)) ?? fromIndexFile(codexHome);
  cache.set(codexHome, names);
  return names;
}
