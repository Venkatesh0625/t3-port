import { parseArgs } from "node:util";
import { PortError } from "../errors.ts";
import { PROVIDERS, type Provider } from "../providers/index.ts";

/**
 * Option table for `node:util`'s parseArgs, which Bun implements.
 *
 * Provider selection flags are generated from the registry, so a new provider brings its own
 * flag rather than needing one added here.
 */
const OPTIONS = {
  all: { type: "boolean" },
  "dry-run": { type: "boolean" },
  project: { type: "string" },
  "force-project": { type: "boolean" },
  "create-project": { type: "boolean" },
  "drop-generated": { type: "boolean" },
  force: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  ...Object.fromEntries(PROVIDERS.map((p) => [p.label, { type: "boolean" as const }])),
} as const;

export interface Args {
  readonly command: string;
  readonly refs: readonly string[];
  readonly flags: Record<string, string | boolean | undefined>;
  /** Providers to act on; all of them unless some were named. */
  readonly providers: readonly Provider[];
}

export function parse(argv: readonly string[]): Args {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new PortError(error instanceof Error ? error.message : String(error));
  }

  const [command = "", ...refs] = parsed.positionals;
  const flags = parsed.values as Record<string, string | boolean | undefined>;
  const chosen = PROVIDERS.filter((p) => flags[p.label] === true);

  return { command, refs, flags, providers: chosen.length > 0 ? chosen : PROVIDERS };
}
