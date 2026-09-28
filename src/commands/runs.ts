import { loadConfig } from "../config.ts";
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
    const state = run.live === 0 ? "undone" : run.projected ? "read by T3" : "not yet read";
    console.log(
      `  ${run.id.slice(0, 8)}  ${run.at.slice(0, 19).replace("T", " ")}  ` +
        `${String(run.threads).padStart(4)} thread(s)  ${state}`,
    );
  }
  console.log(`\nUndo the newest with "t3-port undo", or a specific one with "t3-port undo <id>".`);
  db.close();
  return 0;
}
