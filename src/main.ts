#!/usr/bin/env bun
import { parse } from "./cli/args.ts";
import { USAGE } from "./cli/usage.ts";
import { PortError } from "./errors.ts";
import { doctor } from "./commands/doctor.ts";
import { list } from "./commands/list.ts";
import { runImport } from "./commands/import.ts";
import { runUndo } from "./commands/undo.ts";
import { listRuns } from "./commands/runs.ts";
import { prune } from "./commands/prune.ts";

async function main(argv: readonly string[]): Promise<number> {
  const args = parse(argv);
  if (args.flags.help === true || args.command === "") {
    console.log(USAGE);
    return 0;
  }
  switch (args.command) {
    case "doctor":
      return doctor();
    case "list":
      return await list(args);
    case "import":
      return await runImport(args);
    case "prune":
      return await prune(args);
    case "runs":
      return listRuns();
    case "undo":
      return runUndo(args);
    default:
      console.error(`unknown command '${args.command}'\n`);
      console.log(USAGE);
      return 2;
  }
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (error) {
  if (PortError.is(error)) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
