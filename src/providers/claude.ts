import { existsSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Glob } from "bun";
import { PortError } from "../errors.ts";

import { read as readTranscript } from "./claude.transcript.ts";
import type { Provider } from "./types.ts";

/**
 * Claude Code keeps one directory per working directory — the absolute path with every
 * non-alphanumeric character replaced by "-" — and one .jsonl per session inside it. The
 * filename is the session id, and the same session can exist under two directories.
 */
const dirFor = (root: string, cwd: string): string =>
  join(root, cwd.replace(/[^A-Za-z0-9]/g, "-"));

const scan = (root: string, pattern: string): string[] =>
  existsSync(root) ? [...new Glob(pattern).scanSync({ cwd: root, absolute: true })] : [];

/** Session ids T3 refuses to resume are not worth importing (AgentSessionImporter.ts:32). */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const biggest = (paths: string[]): string =>
  paths.reduce((big, path) => (statSync(path).size > statSync(big).size ? path : big));

export const claude: Provider = {
  id: "claudeAgent",
  label: "claude",
  fallbackModel: "claude-opus-5-5",
  locationAddressed: true,

  // One level deep on purpose: <slug>/<session>.jsonl is a session, while anything below it
  // (<session>/subagents/agent-*.jsonl) is a sidechain of one, which T3 never makes a thread of.
  list: (config) =>
    scan(config.claudeProjects, "*/*.jsonl")
      .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((entry) => entry.path),

  resolve(config, ref) {
    if (ref.endsWith(".jsonl") && existsSync(ref)) return ref;
    const hits = scan(config.claudeProjects, `*/${ref}*.jsonl`);
    const ids = [...new Set(hits.map((h) => basename(h).replace(/\.jsonl$/, "")))].sort();
    if (ids.length === 0) throw new PortError(`no Claude Code session matches '${ref}'`);
    if (ids.length > 1) throw new PortError(`'${ref}' matches ${ids.length}: ${ids.slice(0, 5).join(", ")}`);
    return biggest(hits);
  },

  read: (_config, path) => readTranscript(path),

  isResumable: (sessionId) => SESSION_ID.test(sessionId),

  // Claude resumes by a session id handed to the Agent SDK, so the cursor names both
  // (AgentSessionImporter.ts:234).
  resumeCursor: (threadId, sessionId) => ({ threadId, resume: sessionId }),
  sessionIdFromCursor: (cursor) => (typeof cursor.resume === "string" ? cursor.resume : null),

  place(config, transcript, cwd) {
    const dir = dirFor(config.claudeProjects, cwd);
    const dest = join(dir, basename(transcript));
    if (existsSync(dest)) return null;
    mkdirSync(dir, { recursive: true });
    copyFileSync(transcript, dest);
    return dest;
  },
};
