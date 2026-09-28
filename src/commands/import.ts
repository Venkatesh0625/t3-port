import { loadConfig } from "../config.ts";
import type { Args } from "../cli/args.ts";
import { collectAll, collectRefs } from "../cli/sessions.ts";
import { planSummary } from "../cli/report.ts";
import { apply, plan } from "../ops/import.ts";
import { backup, open } from "../t3/open.ts";

export async function runImport(args: Args): Promise<number> {
  const config = loadConfig();
  const dryRun = args.flags["dry-run"] === true;
  const dropGenerated = args.flags["drop-generated"] === true;

  // No references means every importable session; the filters narrow it from there.
  const sessions =
    args.refs.length === 0
      ? await collectAll(config, args.providers, { dropGenerated })
      : await collectRefs(config, args.providers, args.refs, { dropGenerated });

  const { db, compatibility } = open(config, { write: !dryRun, force: args.flags.force === true });
  const result = plan(
    db,
    sessions,
    {
      project: typeof args.flags.project === "string" ? args.flags.project : undefined,
      forceProject: args.flags["force-project"] === true,
      createProject: args.flags["create-project"] === true,
    },
    config.worktrees,
  );

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
  const done = apply(db, config, result);
  db.close();
  console.log(`imported ${done.threads.length} thread(s) as run ${done.runId.slice(0, 8)}.`);
  console.log(`Start T3 Code to see them, or "t3-port undo" to take them back.`);
  return 0;
}
