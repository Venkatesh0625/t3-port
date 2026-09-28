import type { Config } from "../config.ts";
import { PortError, TooLarge } from "../errors.ts";
import type { Provider, ReadOptions } from "../providers/index.ts";
import type { Session } from "../session.ts";
import { inScope, type Scope } from "../scope.ts";

/**
 * One entry per session, newest first.
 *
 * A transcript can exist in more than one place: Claude keeps a copy at the project root for a
 * session that ran in a worktree, which locally means 434 files for 225 sessions. Listing both
 * would double every count and disagree with what an import does, since planning has always
 * deduplicated. The largest copy wins — it is the one that kept running — which is the rule the
 * providers already use to resolve a session id to a path.
 */
export async function collectAll(
  config: Config,
  providers: readonly Provider[],
  options: ReadOptions,
  scope?: Scope,
): Promise<Collected> {
  const best = new Map<string, Session>();
  const skipped: TooLarge[] = [];
  for (const provider of providers) {
    for (const path of provider.list(config, scope)) {
      let session: Session;
      try {
        session = await provider.read(config, path, options);
      } catch (error) {
        // One unreadable transcript should not cost the user the rest of the listing.
        if (TooLarge.is(error)) {
          skipped.push(error);
          continue;
        }
        throw error;
      }
      // The cheap filter errs towards keeping; this is the decision that counts.
      if (scope && !inScope(session.cwd, scope)) continue;
      const key = `${provider.id}:${session.sessionId}`;
      const existing = best.get(key);
      if (!existing || session.stat.size > existing.stat.size) best.set(key, session);
    }
  }
  return {
    sessions: [...best.values()].sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs),
    skipped,
  };
}

/**
 * Resolve user-supplied references.
 *
 * A reference does not say which agent wrote it, so each provider is asked in turn and the
 * first that recognises it wins. Naming a provider explicitly narrows the search.
 */
export interface Collected {
  readonly sessions: readonly Session[];
  /** Transcripts too large to read, reported rather than silently dropped. */
  readonly skipped: readonly TooLarge[];
}

export async function collectRefs(
  config: Config,
  providers: readonly Provider[],
  refs: readonly string[],
  options: ReadOptions,
): Promise<Session[]> {
  const sessions: Session[] = [];
  for (const ref of refs) {
    let found: Session | null = null;
    const failures: string[] = [];
    for (const provider of providers) {
      try {
        found = await provider.read(config, provider.resolve(config, ref), options);
        break;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (!found) throw new PortError(failures.join("; "));
    sessions.push(found);
  }
  return sessions;
}
