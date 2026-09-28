#!/usr/bin/env bun
import { loadConfig, PortError } from "./config.ts";
import { SessionStore } from "./claude/store.ts";
import { read } from "./claude/transcript.ts";
import { open, backup } from "./t3/open.ts";
import { BASELINE } from "./t3/schema.ts";
import { importedSessionIds, nativeSessionIds } from "./t3/queries.ts";
import { plan, apply, type SkipReason } from "./ops/import.ts";

const USAGE = `t3-port — move conversation history between Claude Code and T3 Code

  t3-port doctor                    check this tool against the installed T3 Code
  t3-port list                      Claude sessions, with their status in T3
  t3-port import [ref...] [flags]   import sessions as T3 threads

Flags
  --all                  every importable session
  --dry-run              plan only, write nothing
  --project <path|id>    force the target project
  --create-project       create a project when none covers the session
  --force                write even if T3's schema drifted from the baseline
`;

interface Args {
  command: string;
  refs: string[];
  flags: Record<string, string | boolean>;
}

function parse(argv: string[]): Args {
  const [command = "", ...rest] = argv;
  const refs: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) {
      refs.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--") && (name === "project" || name === "to")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { command, refs, flags };
}

const SKIP_LABEL: Record<SkipReason, string> = {
  "no-user-turn": "no user turn",
  "unresumable-session-id": "session id T3 cannot resume",
  "already-imported": "already imported",
  "t3-native": "started by T3",
  "no-project": "no project covers its directory",
};

function doctor(): number {
  const config = loadConfig();
  const { db, compatibility } = open(config, { write: false });
  const verdict = compatibility.compatible ? "compatible" : "DRIFTED";
  console.log(`database    ${config.db}`);
  console.log(`migration   ${compatibility.migrationId} (baseline ${BASELINE.migrationId}, ${BASELINE.version})`);
  console.log(`surface     ${verdict}`);

  if (compatibility.newMigrations.length > 0) {
    console.log(`\nmigrations since baseline:`);
    for (const m of compatibility.newMigrations) console.log(`  ${m.id}  ${m.name}`);
  }
  if (compatibility.drift.length > 0) {
    console.log(`\ntables this tool writes that changed:`);
    for (const d of compatibility.drift) {
      console.log(`  ${d.table}  ${d.expected} -> ${d.actual ?? "missing"}`);
    }
    console.log(`\nRe-verify the event shapes against T3's decider before writing.`);
  } else if (compatibility.newMigrations.length > 0) {
    console.log(`\nNone of them touch a table this tool writes; importing is safe.`);
  }
  db.close();
  return compatibility.compatible ? 0 : 1;
}

async function list(): Promise<number> {
  const config = loadConfig();
  const { db } = open(config, { write: false });
  const store = new SessionStore(config.claudeProjects);
  const native = nativeSessionIds(db);
  const imported = importedSessionIds(db);

  const paths = store.list();
  console.log(`${paths.length} Claude session(s) in ${config.claudeProjects}\n`);
  for (const path of paths.slice(0, 40)) {
    const t = await read(path);
    const mark = native.has(t.sessionId) ? "t3" : imported.has(t.sessionId) ? "imported" : "-";
    console.log(
      `${mark.padEnd(9)} ${t.sessionId.slice(0, 8)}  ${String(t.turns.length).padStart(4)} turns  ${t.title.slice(0, 58)}`,
    );
  }
  if (paths.length > 40) console.log(`\n... ${paths.length - 40} more`);
  db.close();
  return 0;
}

async function runImport(args: Args): Promise<number> {
  const config = loadConfig();
  const dryRun = Boolean(args.flags["dry-run"]);
  const store = new SessionStore(config.claudeProjects);

  if (!args.flags.all && args.refs.length === 0) {
    console.error("Name a session, or pass --all.");
    return 2;
  }
  const paths = args.flags.all ? store.list() : args.refs.map((ref) => store.resolve(ref));
  const transcripts = await Promise.all(paths.map(read));

  const { db, compatibility } = open(config, { write: !dryRun, force: Boolean(args.flags.force) });
  const result = plan(db, transcripts, {
    project: typeof args.flags.project === "string" ? args.flags.project : undefined,
    createProject: Boolean(args.flags["create-project"]),
  }, config.worktrees);

  const counts = new Map<SkipReason, number>();
  for (const s of result.skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);

  console.log(`${result.planned.length} to import, ${result.skipped.length} skipped`);
  for (const [reason, n] of counts) console.log(`  ${String(n).padStart(4)}  ${SKIP_LABEL[reason]}`);
  if (result.planned.length > 0) console.log();
  for (const item of result.planned) {
    const root = "create" in item.project ? `${item.project.workspaceRoot} (new)` : item.project.workspaceRoot;
    console.log(`  ${item.transcript.sessionId.slice(0, 8)}  ${String(item.transcript.turns.length).padStart(4)} turns  ${item.transcript.title.slice(0, 44)}`);
    console.log(`            -> ${root}${item.needsCopy ? "  [transcript copied]" : ""}`);
  }

  if (dryRun || result.planned.length === 0) {
    db.close();
    if (dryRun) console.log(`\nDry run: nothing written.`);
    return 0;
  }

  if (!compatibility.compatible) console.log(`\nWarning: schema drift, writing anyway (--force).`);
  const saved = backup(db, config.db);
  console.log(`\nbackup ${saved}`);
  const done = apply(db, store, result);
  db.close();
  console.log(`imported ${done.length} thread(s). Start T3 Code to see them.`);
  return 0;
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  switch (args.command) {
    case "doctor":
      return doctor();
    case "list":
      return await list();
    case "import":
      return await runImport(args);
    default:
      console.log(USAGE);
      return args.command ? 2 : 0;
  }
}

try {
  process.exit(await main());
} catch (error) {
  if (PortError.is(error)) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
