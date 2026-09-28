import { existsSync } from "node:fs";
import { Glob } from "bun";
import { loadConfig } from "../config.ts";
import type { Args } from "../cli/args.ts";
import { requireScope } from "../cli/args.ts";
import { collectAll } from "../cli/sessions.ts";
import { color } from "../cli/color.ts";
import { shortPath } from "../cli/paths.ts";
import { PROVIDERS } from "../providers/index.ts";
import { findRedundant, remove } from "../ops/prune.ts";
import { open } from "../t3/open.ts";

const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(0)} MB`;

export async function prune(args: Args): Promise<number> {
  const config = loadConfig();
  const scope = requireScope(args);
  const { db } = open(config, { write: false });

  // Every provider, since a copy is redundant regardless of which agent wrote it.
  const { sessions } = await collectAll(config, PROVIDERS, { dropGenerated: false }, scope);

  const copiesOf = (sessionId: string): string[] =>
    existsSync(config.claudeProjects)
      ? [...new Glob(`*/${sessionId}.jsonl`).scanSync({ cwd: config.claudeProjects, absolute: true })]
      : [];

  const redundant = findRedundant(db, config, sessions, copiesOf, existsSync);
  db.close();

  const bytes = redundant.reduce((n, entry) => n + entry.bytes, 0);
  if (redundant.length === 0) {
    console.log(`Nothing to reclaim in ${shortPath(scope.root, 48)}.`);
    return 0;
  }

  console.log(
    `${color.bold(String(redundant.length))} redundant transcript copy(s), ${color.bold(mb(bytes))}\n`,
  );
  for (const entry of redundant.slice(0, 12)) {
    console.log(`  ${color.dim(entry.sessionId.slice(0, 8))}  ${String(mb(entry.bytes)).padStart(7)}  ${shortPath(entry.path, 62)}`);
  }
  if (redundant.length > 12) console.log(color.dim(`  ... ${redundant.length - 12} more`));

  console.log(
    color.dim(
      `\nEach has another copy that stays, and none is reachable by \`claude --resume\` or named` +
        `\nby an imported thread. History is not lost; the second copy of it is.`,
    ),
  );

  if (args.flags.delete !== true) {
    console.log(`\nDry run: nothing deleted. Pass --delete to reclaim ${mb(bytes)}.`);
    return 0;
  }

  const done = remove(redundant);
  console.log(`\ndeleted ${done.files} file(s), reclaimed ${mb(done.bytes)}.`);
  return 0;
}
