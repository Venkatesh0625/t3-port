import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { makeScope, type Scope } from "../scope.ts";
import { PortError } from "../errors.ts";
import { PROVIDERS, type Provider } from "../providers/index.ts";

/**
 * Option table for `node:util`'s parseArgs, which Bun implements.
 *
 * Provider selection flags are generated from the registry, so a new provider brings its own
 * flag rather than needing one added here.
 */
const OPTIONS = {
  "dry-run": { type: "boolean" },
  project: { type: "string" },
  path: { type: "string" },
  "force-project": { type: "boolean" },
  "create-project": { type: "boolean" },
  "include-live": { type: "boolean" },
  "include-noise": { type: "boolean" },
  "drop-generated": { type: "boolean" },
  sort: { type: "string" },
  limit: { type: "string" },
  offset: { type: "string" },
  delete: { type: "boolean" },
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

/**
 * The checkout a command works on.
 *
 * Required, because the alternative is reading every transcript on the machine to answer a
 * question about one repository — and because an unscoped command is what turned one mistaken
 * flag into 209 threads in the wrong project.
 */
/** The scope a command was given, if any. */
export function optionalScope(args: Args): Scope | undefined {
  const path = args.flags.path;
  if (typeof path !== "string" || path.length === 0) return undefined;
  return makeScope(resolve(path.replace(/^~/, process.env.HOME ?? "~")));
}

export function requireScope(args: Args): Scope {
  const scope = optionalScope(args);
  if (!scope) {
    throw new PortError("--path <dir> is required: name the checkout to work on, e.g. --path .");
  }
  return scope;
}
