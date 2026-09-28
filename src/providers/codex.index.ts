import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Thread names from ~/.codex/session_index.jsonl.
 *
 * A rollout records the conversation but not what it is called: the name `/rename` sets lives
 * only in this sidecar, one `{id, thread_name, updated_at}` per line. Sessions that were never
 * renamed have no entry, and keep the title derived from their first user turn.
 */
const cache = new Map<string, ReadonlyMap<string, string>>();

export function threadNames(codexHome: string): ReadonlyMap<string, string> {
  const cached = cache.get(codexHome);
  if (cached) return cached;

  const names = new Map<string, string>();
  const path = join(codexHome, "session_index.jsonl");
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const id = typeof entry?.id === "string" ? entry.id : null;
        const name = typeof entry?.thread_name === "string" ? entry.thread_name.trim() : "";
        // Later lines win: the file is appended to as threads are renamed.
        if (id && name) names.set(id, name);
      } catch {
        continue;
      }
    }
  }
  cache.set(codexHome, names);
  return names;
}
