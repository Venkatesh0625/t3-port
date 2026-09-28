#!/usr/bin/env bun
import { resolve } from "node:path";
import { loadConfig, PortError } from "./config.ts";
import { SessionStore } from "./claude/store.ts";
import { read as readClaude } from "./claude/transcript.ts";
import { read as readCodex } from "./codex/rollout.ts";
import { RolloutStore } from "./codex/store.ts";
import type { Session } from "./session.ts";
import { open, backup } from "./t3/open.ts";
import { BASELINE } from "./t3/schema.ts";
import { importedSessionIds, nativeSessionIds } from "./t3/queries.ts";
import { plan, apply, type SkipReason } from "./ops/import.ts";
import { removable, remove } from "./ops/undo.ts";

const USAGE = `t3-port — move conversation history between Claude Code and T3 Code

  t3-port doctor                    check this tool against the installed T3 Code
  t3-port list [--codex|--claude]   sessions on disk, with their status in T3
  t3-port import [ref...] [flags]   import sessions as T3 threads
  t3-port undo [flags]              delete threads this tool imported

Provider selection (both by default)
  --claude               only Claude Code sessions
  --codex                only Codex sessions

Import flags
  --all                  every importable session
  --drop-generated       drop Codex preamble (AGENTS.md, <environment_context>) it injects as
                         user turns; off by default so no real user text is removed
  --dry-run              plan only, write nothing
  --project <path|id>    only sessions that ran under this project
  --force-project        with --project, redirect every session there regardless of where it ran
  --create-project       create a project when none covers the session
  --force                write even if T3's schema drifted from the baseline

Undo flags
  --all                  every imported thread
  --project <path>       only imported threads in this project
  --dry-run              list them, delete nothing
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
  "other-project": "ran outside the named project",
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

interface Selection {
  readonly claude: boolean;
  readonly codex: boolean;
}

function selection(args: Args): Selection {
  const claude = Boolean(args.flags.claude);
  const codex = Boolean(args.flags.codex);
  return claude || codex ? { claude, codex } : { claude: true, codex: true };
}

/** Every session on disk for the selected providers, newest first. */
async function collect(config: ReturnType<typeof loadConfig>, want: Selection, dropGenerated: boolean) {
  const out: Session[] = [];
  if (want.claude) {
    for (const path of new SessionStore(config.claudeProjects).list()) out.push(await readClaude(path));
  }
  if (want.codex) {
    for (const path of new RolloutStore(config.codexHome).list()) {
      out.push(await readCodex(path, { dropGenerated }));
    }
  }
  return out.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
}

async function list(args: Args): Promise<number> {
  const config = loadConfig();
  const { db } = open(config, { write: false });
  const want = selection(args);
  const sessions = await collect(config, want, false);

  const known = new Map<string, { native: Set<string>; imported: Set<string> }>();
  for (const provider of ["claudeAgent", "codex"]) {
    known.set(provider, { native: nativeSessionIds(db, provider), imported: importedSessionIds(db, provider) });
  }

  console.log(`${sessions.length} session(s)\n`);
  for (const s of sessions.slice(0, 40)) {
    const k = known.get(s.provider)!;
    const mark = k.native.has(s.sessionId) ? "t3" : k.imported.has(s.sessionId) ? "imported" : "-";
    const tag = s.provider === "codex" ? "codex " : "claude";
    console.log(
      `${mark.padEnd(9)} ${tag} ${s.sessionId.slice(0, 8)}  ${String(s.turns.length).padStart(4)} turns  ${s.title.slice(0, 48)}`,
    );
  }
  if (sessions.length > 40) console.log(`\n... ${sessions.length - 40} more`);
  db.close();
  return 0;
}

async function runImport(args: Args): Promise<number> {
  const config = loadConfig();
  const dryRun = Boolean(args.flags["dry-run"]);
  const dropGenerated = Boolean(args.flags["drop-generated"]);
  const store = new SessionStore(config.claudeProjects);
  const rollouts = new RolloutStore(config.codexHome);

  if (!args.flags.all && args.refs.length === 0) {
    console.error("Name a session, or pass --all.");
    return 2;
  }

  let sessions: Session[];
  if (args.flags.all) {
    sessions = await collect(config, selection(args), dropGenerated);
  } else {
    sessions = [];
    for (const ref of args.refs) {
      // A reference can name either provider; try Claude's layout, then Codex's.
      try {
        sessions.push(await readClaude(store.resolve(ref)));
      } catch {
        sessions.push(await readCodex(rollouts.resolve(ref), { dropGenerated }));
      }
    }
  }

  const { db, compatibility } = open(config, { write: !dryRun, force: Boolean(args.flags.force) });
  const result = plan(db, sessions, {
    project: typeof args.flags.project === "string" ? args.flags.project : undefined,
    forceProject: Boolean(args.flags["force-project"]),
    createProject: Boolean(args.flags["create-project"]),
  }, config.worktrees);

  const counts = new Map<SkipReason, number>();
  for (const s of result.skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);

  console.log(`${result.planned.length} to import, ${result.skipped.length} skipped`);
  for (const [reason, n] of counts) console.log(`  ${String(n).padStart(4)}  ${SKIP_LABEL[reason]}`);
  if (result.planned.length > 0) console.log();
  for (const item of result.planned) {
    const root = "create" in item.project ? `${item.project.workspaceRoot} (new)` : item.project.workspaceRoot;
    console.log(`  ${item.session.sessionId.slice(0, 8)}  ${String(item.session.turns.length).padStart(4)} turns  ${item.session.title.slice(0, 44)}`);
    console.log(`            -> ${root}${item.needsCopy ? "  [transcript copied]" : ""}`);
  }

  const generated = result.planned.reduce((n, item) => n + item.session.generated, 0);
  if (generated > 0 && !dropGenerated) {
    console.log(
      `\n${generated} Codex-generated turn(s) (AGENTS.md, <environment_context>) will be imported ` +
        `as user messages. Pass --drop-generated to leave them out.`,
    );
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

function runUndo(args: Args): number {
  const config = loadConfig();
  const dryRun = Boolean(args.flags["dry-run"]);
  const scope = typeof args.flags.project === "string" ? args.flags.project : undefined;
  if (!args.flags.all && !scope) {
    console.error("Pass --all, or --project <path> to narrow it.");
    return 2;
  }

  const { db } = open(config, { write: !dryRun, force: Boolean(args.flags.force) });
  const root = scope ? resolve(scope.replace(/^~/, process.env.HOME ?? "~")) : undefined;
  const targets = removable(db, root);

  console.log(`${targets.length} imported thread(s)${root ? ` in ${root}` : ""}`);
  for (const t of targets.slice(0, 15)) {
    console.log(`  ${(t.sessionId ?? t.threadId).slice(0, 8)}  ${t.title.slice(0, 60)}`);
  }
  if (targets.length > 15) console.log(`  ... ${targets.length - 15} more`);

  if (targets.length === 0 || dryRun) {
    db.close();
    if (dryRun) console.log(`\nDry run: nothing deleted.`);
    return 0;
  }

  const saved = backup(db, config.db);
  console.log(`\nbackup ${saved}`);
  const n = remove(db, targets);
  db.close();
  console.log(`deleted ${n} thread(s). Restart T3 Code to see them go.`);
  console.log(`Their sessions become importable again.`);
  return 0;
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  switch (args.command) {
    case "doctor":
      return doctor();
    case "list":
      return await list(args);
    case "import":
      return await runImport(args);
    case "undo":
      return runUndo(args);
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
