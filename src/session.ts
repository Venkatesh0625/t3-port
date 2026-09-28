/** What both providers' transcripts reduce to before they become a T3 thread. */
export type Provider = "claudeAgent" | "codex";

export interface Turn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface Session {
  readonly provider: Provider;
  readonly path: string;
  readonly sessionId: string;
  readonly title: string;
  readonly model: string | null;
  readonly cwd: string | null;
  readonly turns: readonly Turn[];
  readonly stat: { size: number; mtimeMs: number; dev: number; ino: number };
  /** Turns the provider generated rather than the user writing them. */
  readonly generated: number;
}

export const hasUserTurn = (s: Session): boolean => s.turns.some((t) => t.role === "user");

/** A first line of the conversation, for the thread title. */
export function deriveTitle(turns: readonly Turn[], fallback: string): string {
  const opening = turns.find((t) => t.role === "user");
  if (!opening) return fallback;
  return (opening.text.split("\n")[0] ?? "").slice(0, 100).trim() || fallback;
}
