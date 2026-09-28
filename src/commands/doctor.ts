import { loadConfig } from "../config.ts";
import { open } from "../t3/open.ts";
import { BASELINE } from "../t3/schema.ts";

export function doctor(): number {
  const config = loadConfig();
  const { db, compatibility } = open(config, { write: false });

  console.log(`database    ${config.db}`);
  console.log(`migration   ${compatibility.migrationId} (baseline ${BASELINE.migrationId}, ${BASELINE.version})`);
  console.log(`surface     ${compatibility.compatible ? "compatible" : "DRIFTED"}`);

  if (compatibility.newMigrations.length > 0) {
    console.log(`\nmigrations since baseline:`);
    for (const m of compatibility.newMigrations) console.log(`  ${m.id}  ${m.name}`);
  }
  if (compatibility.drift.length > 0) {
    console.log(`\ntables this tool writes that changed:`);
    for (const d of compatibility.drift) console.log(`  ${d.table}  ${d.expected} -> ${d.actual ?? "missing"}`);
    console.log(`\nRe-verify the event shapes against T3's decider before writing.`);
  } else if (compatibility.newMigrations.length > 0) {
    console.log(`\nNone of them touch a table this tool writes; importing is safe.`);
  }

  db.close();
  return compatibility.compatible ? 0 : 1;
}
