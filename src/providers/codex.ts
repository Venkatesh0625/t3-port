import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Glob } from "bun";
import { PortError } from "../errors.ts";
import { read as readRollout } from "./codex.rollout.ts";
import type { Provider } from "./types.ts";

/**
 * Codex rollouts live under ~/.codex/sessions/<yyyy>/<mm>/<dd>/, named
 * rollout-<iso timestamp>-<session uuid>.jsonl. Nothing about where a session ran can be read
 * from its path, and the filename is not the session id — both come from inside the file.
 */
const ROLLOUT = /^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-f-]{36})\.jsonl$/i;

/** The session id encoded in a rollout filename, when it has one. */
export const sessionIdOf = (path: string): string | null =>
  ROLLOUT.exec(basename(path))?.[1]?.toLowerCase() ?? null;

const rollouts = (home: string): string[] =>
  existsSync(home)
    ? [...new Glob("sessions/**/*.jsonl").scanSync({ cwd: home, absolute: true })].filter(
        (path) => sessionIdOf(path) !== null,
      )
    : [];

export const codex: Provider = {
  id: "codex",
  label: "codex",
  // A model T3 has actually seen; rollouts usually name their own in turn_context.
  fallbackModel: "gpt-5.4",
  locationAddressed: false,

  list: (config) =>
    rollouts(config.codexHome)
      .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((entry) => entry.path),

  resolve(config, ref) {
    if (ref.endsWith(".jsonl") && existsSync(ref)) return ref;
    const needle = ref.toLowerCase();
    const hits = this.list(config).filter((path) => sessionIdOf(path)?.startsWith(needle));
    if (hits.length === 0) throw new PortError(`no Codex session matches '${ref}'`);
    const ids = [...new Set(hits.map((h) => sessionIdOf(h)!))];
    if (ids.length > 1) throw new PortError(`'${ref}' matches ${ids.length}: ${ids.slice(0, 5).join(", ")}`);
    return hits[0]!;
  },

  read: (path, options) => readRollout(path, options),

  // Ids come from session_meta rather than a filename, so there is no format to validate.
  isResumable: (sessionId) => sessionId.length > 0,

  // Codex resumes by its own thread id, and T3 stores only that (AgentSessionImporter.ts:234).
  // Writing Claude's shape here would leave the session unresumable.
  resumeCursor: (_threadId, sessionId) => ({ threadId: sessionId }),
  sessionIdFromCursor: (cursor) => (typeof cursor.threadId === "string" ? cursor.threadId : null),

  place: () => null,
};
