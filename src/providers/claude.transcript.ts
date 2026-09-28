import { statSync } from "node:fs";
import { TooLarge } from "../errors.ts";
import { basename } from "node:path";
import { isoFromMs, isoOr } from "../time.ts";
import { deriveTitle, MAX_TRANSCRIPT_BYTES, type Session, type Turn } from "../session.ts";

/**
 * Read a Claude Code transcript.
 *
 * A session file mixes bookkeeping with conversation: `ai-title`, `queue-operation`,
 * `attachment`, `mode`, `cost-state` and others sit alongside `user` and `assistant`. Only the
 * latter two carry turns, and only their `text` blocks are prose — in a representative file 91
 * of 97 `user` records were `tool_result`. Everything else is deliberately dropped: T3 renders
 * imported history as plain turns, and the resumed session still has the full context anyway.
 */

export const FALLBACK_MODEL = "claude-opus-5-5";

const PROSE_BLOCKS = new Set(["text", "input_text", "output_text"]);

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

export async function read(path: string): Promise<Session> {
  const st = statSync(path);
  if (st.size > MAX_TRANSCRIPT_BYTES) throw new TooLarge(path, st.size);
  const fallbackTime = isoFromMs(st.mtimeMs);

  let sessionId = basename(path).replace(/\.jsonl$/, "");
  let aiTitle = "";
  let customTitle = "";
  let model: string | null = null;
  let cwd: string | null = null;
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

    const message = (r.message ?? {}) as Record<string, unknown>;
    const declared = str(message.model);
    if (declared && declared !== "<synthetic>") model = declared;

    if (r.type !== "user" && r.type !== "assistant") continue;
    const text = prose(message.content);
    if (text) turns.push({ role: r.type, text, createdAt: isoOr(r.timestamp, fallbackTime) });
  }

  return {
    provider: "claudeAgent",
    path,
    sessionId,
    title: customTitle || aiTitle || deriveTitle(turns, "Imported thread"),
    model,
    cwd,
    turns,
    stat: { size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino },
    generated: 0,
  };
}
