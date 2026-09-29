import { loadConfig } from "../config.ts";
import { optionalScope, requireScope, type Args } from "../cli/args.ts";
import { collectAll, collectRefs } from "../cli/sessions.ts";
import { planSummary, skipReasons } from "../cli/report.ts";
import { apply, plan } from "../ops/import.ts";
import { backup, open } from "../t3/open.ts";

export async function runImport(args: Args): Promise<number> {
  const config = loadConfig();
  // A named session bounds the work by itself; --path is what bounds an open-ended scan.
  const scope = args.refs.length === 0 ? requireScope(args) : optionalScope(args);
  const dryRun = args.flags["dry-run"] === true;
  const dropGenerated = args.flags["drop-generated"] === true;

  // No references means every importable session; the filters narrow it from there.
  const { sessions } =
    args.refs.length === 0
      ? await collectAll(config, args.providers, { dropGenerated }, scope)
      : { sessions: await collectRefs(config, args.providers, args.refs, { dropGenerated }, scope) };

  const { db, compatibility } = open(config, { write: !dryRun, force: args.flags.force === true });
  const result = plan(
    db,
    sessions,
    {
      project: typeof args.flags.project === "string" ? args.flags.project : undefined,
      forceProject: args.flags["force-project"] === true,
      createProject: args.flags["create-project"] === true,
      includeLive: args.flags["include-live"] === true,
      includeNoise: args.flags["include-noise"] === true,
    },
    config.worktrees,
  );

  // Naming sessions is a question about those sessions; scanning a checkout is a question
  // about the checkout, and only that one wants a tally.
  if (args.refs.length > 0 && result.planned.length === 0) {
    console.log(skipReasons(result));
    return 0;
  }
  console.log(planSummary(result));

  const generated = result.planned.reduce((n, item) => n + item.session.generated, 0);
  if (generated > 0 && !dropGenerated) {
    console.log(
      `\n${generated} provider-generated turn(s) will be imported as user messages. ` +
        `Pass --drop-generated to leave them out.`,
    );
  }

  if (dryRun || result.planned.length === 0) {
    db.close();
    if (dryRun) console.log(`\nDry run: nothing written.`);
    return 0;
  }

  if (!compatibility.compatible) console.log(`\nWarning: schema drift, writing anyway (--force).`);
  console.log(`\nbackup ${backup(db, config.db)}`);
  const done = apply(db, config, result, { settled: args.flags.settled === true });
  db.close();
  console.log(`imported ${done.threads.length} thread(s) as run ${done.runId.slice(0, 8)}.`);
  console.log(`Start T3 Code to see them, or "t3-port undo" to take them back.`);
  return 0;
}
