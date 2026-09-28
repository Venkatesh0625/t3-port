import { statSync } from "node:fs";
import { isoFromMs, isoOr } from "../time.ts";
import { deriveTitle, type Session, type Turn } from "../session.ts";
import { records } from "../jsonl.ts";

/**
 * Read a Codex rollout transcript.
 *
 * Codex records differ from Claude's in every way that matters: files live under
 * ~/.codex/sessions/<y>/<m>/<d>/rollout-<timestamp>-<uuid>.jsonl, so the filename is not the
 * session id and the working directory only appears inside the file. Conversation turns are
 * `response_item` records with an OpenAI-shaped body (`input_text` / `output_text`).
 *
 * The awkward part is that Codex writes a prompt twice — once as a `response_item` and once as
 * an `event_msg` — and injects generated preamble (AGENTS.md, <environment_context>) as extra
 * `response_item` user messages in the same turn. T3 resolves this by trusting a turn only when
 * an `event_msg` copy proves which text the user actually submitted, and keeping everything
 * otherwise rather than risk deleting real user text. This reproduces that rule.
 */

export const FALLBACK_MODEL = "gpt-5.4";

const TEXT_BLOCKS = new Set(["text", "input_text", "output_text"]);

/** Preambles Codex generates and puts in the user's mouth. */
const GENERATED_PREFIXES = [
  "# AGENTS.md instructions for ",
  "<environment_context>",
  "<turn_aborted>",
  "<user_instructions>",
];

export const isGenerated = (text: string): boolean =>
  GENERATED_PREFIXES.some((prefix) => text.startsWith(prefix));

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (typeof type === "string" && TEXT_BLOCKS.has(type) && typeof text === "string" && text.trim()) {
      parts.push(text.trim());
    }
  }
  return parts.join("\n");
}

interface Record_ {
  readonly type?: string;
  readonly timestamp?: string;
  readonly payload?: Record<string, any>;
}

function turnIdOf(payload: Record<string, any>): string | null {
  const meta = payload.internal_chat_message_metadata_passthrough;
  const id = meta && typeof meta === "object" ? meta.turn_id : null;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/**
 * Response-item user records that an event copy proves are duplicates.
 *
 * A turn is trusted only when some `event_msg` in it carries the same text as a response item.
 * Every response-user sharing that turn id is then a duplicate — which is what removes the
 * generated preamble, since Codex injects it into the same turn as the real prompt.
 */
async function duplicateIndices(path: string): Promise<Set<number>> {
  const duplicates = new Set<number>();
  let eventTexts = new Set<string>();
  let pending: Array<{ index: number; turnId: string; text: string }> = [];

  const finishTurn = () => {
    const trusted = new Set(pending.filter((p) => eventTexts.has(p.text)).map((p) => p.turnId));
    for (const entry of pending) if (trusted.has(entry.turnId)) duplicates.add(entry.index);
    eventTexts = new Set();
    pending = [];
  };

  let index = -1;
  for await (const raw of records(path)) {
    index += 1;
    const record = raw as Record_;
    const payload = record.payload ?? {};
    if (record.type === "response_item" && payload.type === "message" && payload.role === "assistant") {
      finishTurn();
      continue;
    }
    if (record.type === "event_msg" && payload.type === "user_message") {
      const text = String(payload.message ?? "").trim();
      if (text) eventTexts.add(text);
      continue;
    }
    if (record.type === "response_item" && payload.type === "message" && payload.role === "user") {
      const turnId = turnIdOf(payload);
      const text = textOf(payload.content);
      if (turnId && text) pending.push({ index, turnId, text });
    }
  }
  finishTurn();
  return duplicates;
}

export interface ReadOptions {
  /**
   * Drop Codex-generated preamble that the event-copy rule could not identify.
   *
   * Off by default: removing text the user might have written is the failure T3 avoids, and on
   * transcripts where Codex wrote no event copies the rule cannot tell them apart.
   */
  readonly dropGenerated?: boolean;
}

export async function read(path: string, options: ReadOptions = {}): Promise<Session> {
  const st = statSync(path);
  const fallbackTime = isoFromMs(st.mtimeMs);

  // Two passes over the file rather than one pass over a copy of it in memory: the first finds
  // which response-item prompts an event proves are duplicates, the second builds the turns.
  const duplicates = await duplicateIndices(path);
  let sessionId = "";
  let model: string | null = null;
  let cwd: string | null = null;
  const turns: Turn[] = [];
  let generated = 0;

  let index = -1;
  for await (const raw of records(path)) {
    index += 1;
    const record = raw as Record_;
    const payload = record.payload ?? {};
    const at = isoOr(record.timestamp, fallbackTime);

    if (record.type === "session_meta") {
      // The filename carries a timestamp too, so only metadata gives a resumable id.
      const id = String(payload.id ?? payload.session_id ?? "").trim();
      if (!sessionId && id) sessionId = id;
      const root = String(payload.cwd ?? "").trim();
      if (!cwd && root) cwd = root;
      continue;
    }
    if (record.type === "turn_context") {
      const declared = String(payload.model ?? "").trim();
      if (declared) model = declared;
      continue;
    }
    if (record.type === "event_msg" && payload.type === "user_message") {
      const text = String(payload.message ?? "").trim();
      if (!text) continue;
      // Drop the response-item copy of this same prompt, back to the last assistant turn.
      for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i]!;
        if (turn.role === "assistant") break;
        if (turn.role === "user" && turn.text.trim() === text) {
          turns.splice(i, 1);
          break;
        }
      }
      turns.push({ role: "user", text, createdAt: at });
      continue;
    }
    if (record.type !== "response_item" || payload.type !== "message") continue;
    if (payload.role !== "user" && payload.role !== "assistant") continue;

    const text = textOf(payload.content);
    if (!text) continue;
    if (payload.role === "user" && duplicates.has(index)) continue;
    if (payload.role === "user" && isGenerated(text)) {
      generated += 1;
      if (options.dropGenerated) continue;
    }
    turns.push({ role: payload.role, text, createdAt: at });
  }

  return {
    provider: "codex",
    path,
    sessionId,
    // Derived from the first turn the user actually wrote, whether or not the generated ones
    // were kept: "# AGENTS.md instructions for ..." names no conversation.
    title: deriveTitle(
      turns.filter((turn) => turn.role !== "user" || !isGenerated(turn.text)),
      "Imported Codex thread",
    ),
    model,
    cwd,
    turns,
    stat: { size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino },
    generated,
  };
}
