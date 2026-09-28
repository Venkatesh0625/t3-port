import { existsSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Glob } from "bun";
import { PortError } from "../config.ts";

/**
 * Claude Code keeps one directory per working directory, named by replacing every
 * non-alphanumeric character in the absolute path with "-", and one .jsonl per session inside
 * it. The same session can therefore exist under two directories; when it does, the larger
 * file is the one that kept running.
 */
export class SessionStore {
  constructor(private readonly root: string) {}

  dirFor(cwd: string): string {
    return join(this.root, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  }

  pathFor(cwd: string, sessionId: string): string {
    return join(this.dirFor(cwd), `${sessionId}.jsonl`);
  }

  private glob(pattern: string): string[] {
    if (!existsSync(this.root)) return [];
    return [...new Glob(pattern).scanSync({ cwd: this.root, absolute: true })];
  }

  /** Every transcript, most recently touched first. */
  list(): string[] {
    return this.glob("*/*.jsonl")
      .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((entry) => entry.path);
  }

  /** The largest copy of a session id, across every directory holding one. */
  locate(sessionId: string): string | null {
    const hits = this.glob(`*/${sessionId}.jsonl`);
    if (hits.length === 0) return null;
    return hits.reduce((big, path) => (statSync(path).size > statSync(big).size ? path : big));
  }

  /** Resolve a user-supplied reference: a file path, a full session id, or a unique prefix. */
  resolve(ref: string): string {
    if (ref.endsWith(".jsonl") && existsSync(ref)) return ref;
    const hits = this.glob(`*/${ref}*.jsonl`);
    const ids = [...new Set(hits.map((h) => basename(h).replace(/\.jsonl$/, "")))].sort();
    if (ids.length === 0) throw new PortError(`no Claude Code session matches '${ref}'`);
    if (ids.length > 1) throw new PortError(`'${ref}' matches ${ids.length}: ${ids.slice(0, 5).join(", ")}`);
    return hits.reduce((big, path) => (statSync(path).size > statSync(big).size ? path : big));
  }

  /** Place a transcript under another directory so `claude --resume` finds it from there. */
  copyUnder(transcript: string, cwd: string): string | null {
    const dest = join(this.dirFor(cwd), basename(transcript));
    if (existsSync(dest)) return null;
    mkdirSync(this.dirFor(cwd), { recursive: true });
    copyFileSync(transcript, dest);
    return dest;
  }
}
