import { statSync } from "node:fs";
import { basename } from "node:path";
import { isoFromMs, isoOr } from "../time.ts";

/**
 * Claude Code transcripts are JSONL, one record per line, appended as a session runs.
 *
 * A session file mixes bookkeeping with conversation: `ai-title`, `queue-operation`,
 * `attachment`, `mode`, `cost-state` and others sit alongside `user` and `assistant`. Only the
 * latter two carry turns, and only their `text` blocks are prose — in a representative file 91
 * of 97 `user` records were `tool_result`. Everything else is deliberately dropped: T3 renders
 * imported history as plain turns, and the resumed session still has the full context anyway.
 */

export const FALLBACK_MODEL = "claude-opus-5-5";

const PROSE_BLOCKS = new Set(["text", "input_text", "output_text"]);

export interface Turn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface Transcript {
  readonly path: string;
  readonly sessionId: string;
  readonly title: string;
  readonly model: string | null;
  readonly cwd: string | null;
  readonly branch: string | null;
  readonly turns: readonly Turn[];
  readonly updatedAt: string;
  readonly stat: { size: number; mtimeMs: number; dev: number; ino: number };
}

/** Prose out of a message body, which is either a bare string or a block list. */
export function prose(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (typeof type === "string" && PROSE_BLOCKS.has(type) && typeof text === "string") {
      const trimmed = text.trim();
      if (trimmed) parts.push(trimmed);
    }
  }
  return parts.join("\n");
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Records that describe the harness rather than the conversation. */
function isNoise(record: Record<string, unknown>): boolean {
  return Boolean(record.isSidechain || record.isMeta || record.isCompactSummary);
}

export async function read(path: string): Promise<Transcript> {
  const st = statSync(path);
  const fallbackTime = isoFromMs(st.mtimeMs);

  let sessionId = basename(path).replace(/\.jsonl$/, "");
  let aiTitle = "";
  let customTitle = "";
  let model: string | null = null;
  let cwd: string | null = null;
  let branch: string | null = null;
  const turns: Turn[] = [];

  for (const line of (await Bun.file(path).text()).split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a torn final line while Claude is writing
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const r = record as Record<string, unknown>;
    if (isNoise(r)) continue;

    sessionId = str(r.sessionId) || sessionId;
    aiTitle = str(r.aiTitle) || aiTitle;
    customTitle = str(r.customTitle) || customTitle;
    cwd ??= str(r.cwd) || null;
    branch = str(r.gitBranch) || branch;

    const message = (r.message ?? {}) as Record<string, unknown>;
    const declared = str(message.model);
    if (declared && declared !== "<synthetic>") model = declared;

    if (r.type !== "user" && r.type !== "assistant") continue;
    const text = prose(message.content);
    if (text) {
      turns.push({ role: r.type, text, createdAt: isoOr(r.timestamp, fallbackTime) });
    }
  }

  const opening = turns.find((t) => t.role === "user");
  const derived = opening ? (opening.text.split("\n")[0] ?? "").slice(0, 100).trim() : "";

  return {
    path,
    sessionId,
    title: customTitle || aiTitle || derived || "Imported thread",
    model,
    cwd,
    branch,
    turns,
    updatedAt: fallbackTime,
    stat: { size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino },
  };
}

export const hasUserTurn = (t: Transcript): boolean => t.turns.some((x) => x.role === "user");
