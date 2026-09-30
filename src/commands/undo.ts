import { loadConfig } from "../config.ts";
import type { Args } from "../cli/args.ts";
import { threadList } from "../cli/report.ts";
import { referableIds } from "../cli/sessions.ts";
import { PortError } from "../errors.ts";
import { threadsOf, undoRun } from "../ops/undo.ts";
import { backup, open } from "../t3/open.ts";
import { find, latestUndoable } from "../t3/runs.ts";

/**
 * Undo the most recent import, or a named one.
 *
 * Runs are a stack: with no argument this pops the newest that still has threads.
 */
export function runUndo(args: Args): number {
  const config = loadConfig();
  const dryRun = args.flags["dry-run"] === true;

  const { db } = open(config, { write: !dryRun, force: args.flags.force === true });
  const ref = args.refs[0];
  const run = ref ? find(db, ref) : latestUndoable(db);

  if (!run) {
    db.close();
    if (ref) throw new PortError(`no import run matches '${ref}'`);
    console.log("No import to undo.");
    return 0;
  }
  if (run.live === 0) {
    db.close();
    console.log(`Run ${run.id.slice(0, 8)} has already been undone.`);
    return 0;
  }

  const threads = threadsOf(db, run);
  console.log(`run ${run.id.slice(0, 8)}  ${run.at}  ${run.threads} thread(s)`);
  console.log(threadList(threads, referableIds(config)));
  console.log(
    run.projected
      ? `\nT3 has already read this run, so its threads will be deleted the way T3 deletes a\n` +
          `thread. Their sessions stay marked as imported: the thread id comes from the session,\n` +
          `so re-importing would give one stream two creation events.`
      : `\nT3 has not read this run yet, so it will be lifted out entirely — no trace, and those\n` +
          `sessions become importable again.`,
  );

  if (dryRun) {
    db.close();
    console.log(`\nDry run: nothing changed.`);
    return 0;
  }

  console.log(`\nbackup ${backup(db, config.db)}`);
  const result = undoRun(db, run);
  db.close();
  console.log(
    result.reversal === "removed"
      ? `removed ${result.threads} thread(s) and ${result.events} event(s). The import is undone.`
      : `deleted ${result.threads} thread(s). Restart T3 Code to see them go.`,
  );
  return 0;
}
