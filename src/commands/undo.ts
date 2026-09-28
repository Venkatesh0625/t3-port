import { resolve } from "node:path";
import { loadConfig } from "../config.ts";
import type { Args } from "../cli/args.ts";
import { threadList } from "../cli/report.ts";
import { remove, removable } from "../ops/undo.ts";
import { backup, open } from "../t3/open.ts";

export function runUndo(args: Args): number {
  const config = loadConfig();
  const dryRun = args.flags["dry-run"] === true;
  const scope = typeof args.flags.project === "string" ? args.flags.project : undefined;

  if (args.flags.all !== true && !scope) {
    console.error("Pass --all, or --project <path> to narrow it.");
    return 2;
  }

  const { db } = open(config, { write: !dryRun, force: args.flags.force === true });
  const root = scope ? resolve(scope.replace(/^~/, process.env.HOME ?? "~")) : undefined;
  const targets = removable(db, root);

  console.log(`${targets.length} imported thread(s)${root ? ` in ${root}` : ""}`);
  if (targets.length > 0) console.log(threadList(targets));

  if (targets.length === 0 || dryRun) {
    db.close();
    if (dryRun) console.log(`\nDry run: nothing deleted.`);
    return 0;
  }

  console.log(`\nbackup ${backup(db, config.db)}`);
  const n = remove(db, targets);
  db.close();
  console.log(`deleted ${n} thread(s). Restart T3 Code to see them go.`);
  console.log(`Their sessions stay marked as imported: a thread id is derived from the session,`);
  console.log(`so re-importing would give one stream two creation events.`);
  return 0;
}
