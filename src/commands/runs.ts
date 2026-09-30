import { loadConfig } from "../config.ts";
import { color } from "../cli/color.ts";
import { open } from "../t3/open.ts";
import { runs } from "../t3/runs.ts";

export function listRuns(): number {
  const config = loadConfig();
  const { db } = open(config, { write: false });
  const all = runs(db);

  if (all.length === 0) {
    console.log("No imports yet.");
    db.close();
    return 0;
  }

  console.log(`${all.length} import run(s), newest first\n`);
  for (const run of all) {
    const state =
      run.live === 0
        ? color.dim("undone")
        : run.projected
          ? color.yellow("read by T3")
          : color.green("not yet read");
    console.log(
      `  ${color.bold(run.id.slice(0, 8))}  ${color.dim(run.at.slice(0, 19).replace("T", " "))}  ` +
        `${String(run.threads).padStart(4)} thread(s)  ${state}`,
    );
  }
  console.log(`\nUndo the newest with "t3p undo", or a specific one with "t3p undo <id>".`);
  db.close();
  return 0;
}
