import type { Config } from "../config.ts";
import { PortError } from "../errors.ts";
import type { Provider, ReadOptions } from "../providers/index.ts";
import type { Session } from "../session.ts";

/** Every session on disk for the given providers, newest first. */
export async function collectAll(
  config: Config,
  providers: readonly Provider[],
  options: ReadOptions,
): Promise<Session[]> {
  const sessions: Session[] = [];
  for (const provider of providers) {
    for (const path of provider.list(config)) sessions.push(await provider.read(path, options));
  }
  return sessions.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
}

/**
 * Resolve user-supplied references.
 *
 * A reference does not say which agent wrote it, so each provider is asked in turn and the
 * first that recognises it wins. Naming a provider explicitly narrows the search.
 */
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
        found = await provider.read(provider.resolve(config, ref), options);
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
