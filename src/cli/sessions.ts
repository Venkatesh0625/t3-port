import type { Config } from "../config.ts";
import { PortError } from "../errors.ts";
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
  for (const provider of providers) {
    for (const path of provider.list(config, scope)) {
      const session = await provider.read(config, path, options);
      // The cheap filter errs towards keeping; this is the decision that counts.
      if (scope && !inScope(session.cwd, scope)) continue;
      const key = `${provider.id}:${session.sessionId}`;
      const existing = best.get(key);
      if (!existing || session.stat.size > existing.stat.size) best.set(key, session);
    }
  }
  return { sessions: [...best.values()].sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs) };
}

/**
 * Resolve user-supplied references.
 *
 * A reference does not say which agent wrote it, so every provider is asked and an unambiguous
 * match wins. A scope disambiguates when more than one agent claims the same reference; it does
 * not reject, because naming a session is already as specific as an instruction gets and being
 * told it is "not in" the directory it plainly ran in helps nobody.
 */
export interface Collected {
  readonly sessions: readonly Session[];
}

export async function collectRefs(
  config: Config,
  providers: readonly Provider[],
  refs: readonly string[],
  options: ReadOptions,
  scope?: Scope,
): Promise<Session[]> {
  const sessions: Session[] = [];
  for (const ref of refs) {
    const matches: Session[] = [];
    const failures: string[] = [];
    for (const provider of providers) {
      try {
        matches.push(await provider.read(config, provider.resolve(config, ref), options));
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (matches.length === 0) {
      // Report only what a provider said about a reference it recognised the shape of; every
      // other provider saying "no match" is noise around the one message that matters.
      const said = failures.filter((message) => !/^no \w+/i.test(message));
      throw new PortError(said.length > 0 ? said.join("; ") : `no session matches '${ref}'`);
    }

    const preferred = scope ? matches.filter((session) => inScope(session.cwd, scope)) : [];
    const chosen = preferred.length === 1 ? preferred[0]! : matches[0]!;
    if (matches.length > 1 && preferred.length !== 1) {
      throw new PortError(
        `'${ref}' matches ${matches.length} sessions across agents; name one with --claude or --codex`,
      );
    }
    sessions.push(chosen);
  }
  return sessions;
}
