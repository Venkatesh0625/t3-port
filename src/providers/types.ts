import type { Config } from "../config.ts";
import type { Session } from "../session.ts";

/**
 * Everything that differs between the agents whose history we import.
 *
 * Provider differences used to live as conditionals spread through planning, querying and the
 * CLI, which meant a third agent would have to be threaded through all of them. They are
 * collected here instead: a provider is one module, and the rest of the code only sees this
 * interface.
 */
export interface Provider {
  /** T3's provider instance id. Thread ids and bindings are namespaced by it. */
  readonly id: string;
  /** Short name used for flags and output. */
  readonly label: string;
  /** Model recorded when a transcript never names one. */
  readonly fallbackModel: string;

  /** Transcript paths on disk, newest first. */
  list(config: Config): string[];
  /** Resolve a user-supplied reference to a transcript path. */
  resolve(config: Config, ref: string): string;
  read(path: string, options: ReadOptions): Promise<Session>;

  /** Whether T3 can resume this session id at all. */
  isResumable(sessionId: string): boolean;
  /** The cursor T3 stores so the next message continues this session. */
  resumeCursor(threadId: string, sessionId: string): unknown;
  /** The session id inside a stored cursor, for spotting sessions T3 started itself. */
  sessionIdFromCursor(cursor: Record<string, unknown>): string | null;

  /**
   * Whether the agent finds a transcript by the directory it ran in.
   *
   * Claude does, so moving a thread to a project root means placing a copy there. Codex
   * addresses rollouts by id and needs nothing.
   */
  readonly locationAddressed: boolean;
  /** Place a transcript under `cwd` so the agent finds it from there. */
  place(config: Config, transcript: string, cwd: string): string | null;
}

export interface ReadOptions {
  /** Drop preamble the provider generated and attributed to the user. */
  readonly dropGenerated?: boolean;
}
