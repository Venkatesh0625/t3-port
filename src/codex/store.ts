import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Glob } from "bun";
import { PortError } from "../config.ts";

/**
 * Codex rollouts live under ~/.codex/sessions/<yyyy>/<mm>/<dd>/, named
 * rollout-<iso timestamp>-<session uuid>.jsonl. Unlike Claude there is no directory per working
 * directory, so nothing about a session's location can be read from its path.
 */
const ROLLOUT = /^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-f-]{36})\.jsonl$/i;

export class RolloutStore {
  constructor(private readonly root: string) {}

  private glob(pattern: string): string[] {
    if (!existsSync(this.root)) return [];
    return [...new Glob(pattern).scanSync({ cwd: this.root, absolute: true })];
  }

  /** The session id encoded in a rollout filename, when it has one. */
  static sessionIdOf(path: string): string | null {
    return ROLLOUT.exec(basename(path))?.[1]?.toLowerCase() ?? null;
  }

  list(): string[] {
    return this.glob("sessions/**/*.jsonl")
      .filter((path) => RolloutStore.sessionIdOf(path) !== null)
      .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((entry) => entry.path);
  }

  resolve(ref: string): string {
    if (ref.endsWith(".jsonl") && existsSync(ref)) return ref;
    const needle = ref.toLowerCase();
    const hits = this.list().filter((path) => RolloutStore.sessionIdOf(path)?.startsWith(needle));
    if (hits.length === 0) throw new PortError(`no Codex session matches '${ref}'`);
    const ids = [...new Set(hits.map((h) => RolloutStore.sessionIdOf(h)!))];
    if (ids.length > 1) throw new PortError(`'${ref}' matches ${ids.length}: ${ids.slice(0, 5).join(", ")}`);
    return hits[0]!;
  }
}
